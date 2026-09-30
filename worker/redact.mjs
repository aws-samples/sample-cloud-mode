// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Credential redaction for everything the worker persists.
 *
 * Transcripts are the audit trail this system depends on: after a review-free
 * merge they are the only record of what the agent did. But they quote
 * prompts, tool output and file contents verbatim, so a repository that happens
 * to contain a credential — a committed `.env`, a fixture key, a token echoed by
 * a build script — gets that credential copied into S3 and CloudWatch. The audit
 * trail then becomes the easiest place in the system to steal a secret.
 *
 * What this module does and does not do:
 *   - It masks **credential-shaped** strings. Shape is preserved (`ghp_****`
 *     plus a length hint) so a transcript stays debuggable and an investigator
 *     can still see that a token was present.
 *   - It does **not** redact source code. Code in prompts is inherent to the
 *     workflow and remains an accepted risk; pretending otherwise would
 *     shred the transcript's usefulness for no security gain.
 *
 * Applied on the *write path* (`transcript-archive.mjs` and the worker's stdout
 * logger) rather than at each call site, so a newly added event type cannot
 * bypass it.
 */

/** Cap on a single serialised event, so one payload cannot dominate the artifact. */
export const MAX_EVENT_CHARS = Number(process.env.CLOUD_MODE_MAX_EVENT_CHARS ?? 64_000);

/** `[redacted <label>, <n> chars]` — shape-preserving, value-destroying. */
function mask(label, value) {
	const len = typeof value === "string" ? value.length : 0;
	return `[redacted ${label}, ${len} chars]`;
}

/**
 * Ordered rules. Each entry is [label, regex, replacer]. Order matters: the most
 * specific shapes run first so a generic rule cannot swallow a precise one.
 */
const RULES = [
	// ── AWS ───────────────────────────────────────────────────────────────────
	["aws-access-key-id", /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g, (m) => mask("aws-access-key-id", m)],
	[
		"aws-secret-access-key",
		/\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secretAccessKey)\b(\s*[:=]\s*)["']?([A-Za-z0-9/+=]{40})["']?/g,
		(_m, key, sep, secret) => `${key}${sep}${mask("aws-secret-access-key", secret)}`,
	],
	[
		"aws-session-token",
		/\b(aws_session_token|AWS_SESSION_TOKEN|sessionToken)\b(\s*[:=]\s*)["']?([A-Za-z0-9/+=_-]{100,})["']?/g,
		(_m, key, sep, secret) => `${key}${sep}${mask("aws-session-token", secret)}`,
	],
	// ── GitHub ────────────────────────────────────────────────────────────────
	["github-token", /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,})\b/g, (m) => mask("github-token", m)],
	["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, (m) => mask("github-pat", m)],
	// x-access-token:<token>@github.com — the classic URL-embedded credential.
	[
		"git-url-credential",
		/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g,
		(_m, scheme, user) => `${scheme}${user}:${mask("git-url-credential", "")}@`,
	],
	// ── Generic bearer / private keys ─────────────────────────────────────────
	[
		"authorization-header",
		/\b(Authorization|authorization)(\s*[:=]\s*)["']?(Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{8,})["']?/g,
		(_m, key, sep, scheme, secret) => `${key}${sep}${scheme} ${mask("authorization-header", secret)}`,
	],
	[
		"private-key",
		/-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
		(m) => mask("private-key", m),
	],
	["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, (m) => mask("jwt", m)],
	// ── .env-style assignments for secret-ish names ───────────────────────────
	// Deliberately narrow: the key name must *look* like a secret, so ordinary
	// configuration (PORT=8080, NODE_ENV=test) survives untouched.
	[
		"secret-assignment",
		/\b([A-Za-z_][A-Za-z0-9_]{0,48}(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIAL)S?)\b(\s*[:=]\s*)["']?([^\s"'#,;)}\]]{8,})["']?/gi,
		(_m, key, sep, secret) => `${key}${sep}${mask("secret-assignment", secret)}`,
	],
	// ── Cloud Mode's own secrets ──────────────────────────────────────────────
	[
		"cloud-mode-token",
		/\b(CLOUD_MODE_GIT_TOKEN|ownerToken|owner_token|bearerToken|brokerToken)\b(\s*[:=]\s*)["']?([A-Za-z0-9._~+/=-]{8,})["']?/g,
		(_m, key, sep, secret) => `${key}${sep}${mask("cloud-mode-token", secret)}`,
	],
];

/** Redact one string. Returns the string unchanged when nothing matched. */
export function redactString(value) {
	if (typeof value !== "string" || value.length < 8) return value;
	let out = value;
	for (const [, re, replacer] of RULES) out = out.replace(re, replacer);
	return out;
}

/**
 * Redact recursively through objects and arrays, so a credential nested in a
 * tool's input or output is caught as reliably as one in a top-level message.
 * Cycles are tolerated (events are serialisable, but a bug should not hang the
 * archive path).
 */
export function redactValue(value, seen = new WeakSet()) {
	if (typeof value === "string") return redactString(value);
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));
	const out = {};
	for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, seen);
	return out;
}

/**
 * Serialise one event for the artifact: redacted, and capped so a single huge
 * payload cannot crowd out the rest of the run's history.
 */
export function serializeEvent(event, { maxChars = MAX_EVENT_CHARS } = {}) {
	let line = JSON.stringify(redactValue(event));
	if (line.length > maxChars) {
		const kept = line.slice(0, maxChars);
		line = JSON.stringify({
			type: event?.type ?? "unknown",
			seq: event?.seq,
			truncated: true,
			originalChars: line.length,
			payloadHead: kept,
		});
	}
	return line;
}

/**
 * Wrap a log function so stdout (and therefore CloudWatch) is redacted too.
 * The same chokepoint reasoning applies: individual call sites must not have to
 * remember.
 */
export function redactingLogger(sink = console.log) {
	return (...args) => sink(...args.map((a) => (typeof a === "string" ? redactString(a) : redactValue(a))));
}

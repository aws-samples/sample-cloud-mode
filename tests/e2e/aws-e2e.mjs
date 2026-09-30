// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Real end-to-end driver for Cloud Mode against the DEPLOYED AgentCore runtime.
 *
 * Exercises the extension's OWN transport + SSE parsing (agentcore.ts →
 * sse.ts) against the real worker container running on Bedrock AgentCore. It
 * opens a session-scoped streaming invoke ({action:"start", ...}), renders the
 * live event stream, and asserts the worker completes the story lifecycle:
 * clone → solve → push → open PR.
 *
 * No fake worker, no localUrl seam — this is the AWS path only.
 *
 * Env:
 *   CLOUD_MODE_REGION, CLOUD_MODE_RUNTIME_ARN, CLOUD_MODE_QUALIFIER
 *   E2E_REPO_URL, E2E_REPO_NWO, E2E_BASE_BRANCH, E2E_STORY_ID, E2E_STORY
 *
 * Prints "E2E RESULT: PASS" and exits 0 on success.
 */
import { randomUUID } from "node:crypto";
import { invokeAgentRuntime } from "../../.pi/extensions/cloud-mode/agentcore.ts";

const region = process.env.CLOUD_MODE_REGION;
const agentRuntimeArn = process.env.CLOUD_MODE_RUNTIME_ARN;
const qualifier = process.env.CLOUD_MODE_QUALIFIER ?? "DEFAULT";
if (!region || !agentRuntimeArn) {
	console.error("Missing CLOUD_MODE_REGION / CLOUD_MODE_RUNTIME_ARN");
	process.exit(2);
}

const storyId = process.env.E2E_STORY_ID ?? `E2E-${Date.now()}`;
const payload = {
	action: "start",
	storyId,
	userStory:
		process.env.E2E_STORY ??
		`Create a file named CLOUD_MODE_E2E.md at the repo root containing exactly one line: "hello from cloud mode e2e ${storyId}". Do not change anything else.`,
	repoUrl: process.env.E2E_REPO_URL,
	repoNwo: process.env.E2E_REPO_NWO,
	baseBranch: process.env.E2E_BASE_BRANCH ?? "main",
};

// runtime-session-id must be >= 33 chars.
const sessionId = `cloudmode-${randomUUID()}${randomUUID().replace(/-/g, "")}`.slice(0, 90);

console.log(`== invoking ${agentRuntimeArn} (session ${sessionId}) ==`);
console.log(`   story ${storyId} → ${payload.repoNwo}`);

const seen = new Set();
let prUrl;
let doneCode;
let errorMessage;

const timeout = Number(process.env.E2E_TIMEOUT_MS ?? 600_000);
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), timeout);

try {
	for await (const raw of invokeAgentRuntime({ region, agentRuntimeArn, qualifier, sessionId, payload, signal: ac.signal })) {
		const ev = raw ?? {};
		const t = ev.type ?? "?";
		seen.add(t);
		if (t === "cloud_status") console.log(`  · status: ${ev.status}${ev.repoNwo ? ` ${ev.repoNwo}` : ""}`);
		else if (t === "message_end") {
			const text = extractText(ev.message);
			if (text) console.log(`  💬 ${text.slice(0, 200).replace(/\n/g, " ")}`);
			else console.log(`  · message_end (${ev.message?.role})`);
		} else if (t === "cloud_pr") {
			prUrl = ev.url;
			console.log(`  ✅ PR: ${ev.url} (branch ${ev.branch})`);
		} else if (t === "cloud_error") {
			errorMessage = ev.message;
			console.log(`  ⚠️  error: ${ev.message}`);
		} else if (t === "cloud_done") {
			doneCode = ev.exitCode;
			console.log(`  🏁 done (exit ${ev.exitCode})`);
		} else {
			console.log(`  · ${t}`);
		}
	}
} catch (e) {
	errorMessage = e?.name === "AbortError" ? `timed out after ${timeout}ms` : (e?.message ?? String(e));
} finally {
	clearTimeout(timer);
}

function extractText(message) {
	if (!message) return "";
	const c = message.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
	return "";
}

console.log(`\n== events seen: ${[...seen].join(", ")} ==`);

let failed = false;
const check = (desc, ok) => {
	console.log(`${ok ? "PASS" : "FAIL"}: ${desc}`);
	if (!ok) failed = true;
};

check("received worker status events", seen.has("cloud_status"));
check("stream reached cloud_done", doneCode !== undefined);
check("worker finished without error", !errorMessage && doneCode === 0);
check("a pull request was opened", Boolean(prUrl));

if (errorMessage) console.log(`\nlast error: ${errorMessage}`);
console.log(`\nE2E RESULT: ${failed ? "FAIL" : "PASS"}`);
process.exit(failed ? 1 : 0);

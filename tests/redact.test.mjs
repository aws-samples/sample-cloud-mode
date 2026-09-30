// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for credential redaction on the persistence path.
 *
 * Two invariants, both necessary:
 *   1. A planted credential of each known shape never appears verbatim in the
 *      serialised transcript or in a log line.
 *   2. Ordinary content — source code, diffs, mundane configuration — survives
 *      intact. A redactor that shreds the transcript would be switched off, and
 *      then it protects nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MAX_EVENT_CHARS, redactingLogger, redactString, redactValue, serializeEvent } from "../worker/redact.mjs";

/**
 * The planted credentials are ASSEMBLED rather than written out, so that this
 * file contains no literal that a secret scanner must be taught to ignore. An
 * allow-listed scanner is a scanner that will miss the real thing later.
 */
const PLANTED = {
	awsKeyId: `AKIA${"IOSFODNN7EXAMPLE"}`,
	awsSecret: `wJalrXUtnFEMI/K7MDENG/${"bPxRfiCYEXAMPLEKEY"}`,
	awsSession: `FwoGZXIvYXdzE${"A".repeat(120)}`,
	ghToken: `ghp${"_"}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`,
	ghsToken: `ghs${"_"}1234567890abcdefghijklmnopqrstuvwxyz`,
	ghPat: `github${"_pat_"}11ABCDEFG0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd`,
	jwt: "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxMjM0NSJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU",
	pem: [
		`-----BEGIN RSA ${"PRIVATE"} KEY-----`,
		"MIIEowIBAAKCAQEA1234567890",
		"abcdefghij",
		`-----END RSA ${"PRIVATE"} KEY-----`,
	].join("\n"),
};

test("every planted credential shape is masked", () => {
	const cases = [
		`AWS_ACCESS_KEY_ID=${PLANTED.awsKeyId}`,
		`aws_secret_access_key = ${PLANTED.awsSecret}`,
		`AWS_SESSION_TOKEN="${PLANTED.awsSession}"`,
		`git remote add origin https://x-access-token:${PLANTED.ghsToken}@github.com/acme/widgets.git`,
		`token: ${PLANTED.ghToken}`,
		`PAT is ${PLANTED.ghPat}`,
		`Authorization: Bearer ${PLANTED.jwt}`,
		PLANTED.pem,
		`GITHUB_TOKEN=${PLANTED.ghToken}`,
		`DB_PASSWORD=sup3rs3cretvalue`,
		`CLOUD_MODE_GIT_TOKEN=${PLANTED.ghsToken}`,
	];
	for (const input of cases) {
		const out = redactString(input);
		for (const secret of Object.values(PLANTED)) {
			assert.ok(!out.includes(secret), `secret survived redaction in: ${input.slice(0, 60)} -> ${out.slice(0, 120)}`);
		}
		assert.ok(!out.includes("sup3rs3cretvalue"), `password survived: ${out}`);
		assert.match(out, /\[redacted /, `nothing was masked in: ${input.slice(0, 60)}`);
	}
});

test("masking preserves shape and length hint for debuggability", () => {
	const out = redactString(`token: ${PLANTED.ghToken}`);
	assert.match(out, /\[redacted github-token, \d+ chars\]/);
});

test("ordinary code and configuration survive untouched", () => {
	const code = [
		"export function add(a, b) {",
		"  return a + b; // PORT=8080, NODE_ENV=test",
		"}",
		"const url = 'https://github.com/acme/widgets.git';",
		"if (retries > 3) throw new Error('too many retries');",
	].join("\n");
	assert.equal(redactString(code), code, "a normal diff must pass through unchanged");
	assert.equal(redactString("PORT=8080"), "PORT=8080");
	assert.equal(redactString("NODE_ENV=production"), "NODE_ENV=production");
	assert.equal(redactString("timeout=30000"), "timeout=30000");
});

test("a clean repository URL is not treated as a credential", () => {
	const url = "https://github.com/acme/widgets.git";
	assert.equal(redactString(url), url);
});

test("redaction reaches nested tool input and output", () => {
	const event = {
		type: "message_end",
		message: {
			role: "toolResult",
			toolName: "bash",
			content: [{ type: "text", text: `env | grep AWS\nAWS_ACCESS_KEY_ID=${PLANTED.awsKeyId}` }],
			details: { nested: { deeper: [`Authorization: Bearer ${PLANTED.jwt}`] } },
		},
	};
	const line = serializeEvent(event);
	assert.ok(!line.includes(PLANTED.awsKeyId), "nested credential survived");
	assert.ok(!line.includes(PLANTED.jwt), "deeply nested credential survived");
	assert.match(line, /redacted aws-access-key-id/);
});

test("a huge payload is capped with an explicit truncation marker", () => {
	const event = { type: "cloud_status", seq: 42, blob: "x".repeat(MAX_EVENT_CHARS + 5_000) };
	const line = serializeEvent(event);
	const parsed = JSON.parse(line);
	assert.equal(parsed.truncated, true);
	assert.equal(parsed.type, "cloud_status");
	assert.equal(parsed.seq, 42);
	assert.ok(parsed.originalChars > MAX_EVENT_CHARS);
	assert.ok(line.length <= MAX_EVENT_CHARS + 500, "capped line must stay near the limit");
});

test("a normal event is not truncated and stays valid JSON", () => {
	const event = { type: "cloud_pr", seq: 7, url: "https://github.com/acme/widgets/pull/1" };
	const parsed = JSON.parse(serializeEvent(event));
	assert.deepEqual(parsed, event);
});

test("redactValue tolerates cycles instead of hanging the archive path", () => {
	const a = { type: "x" };
	a.self = a;
	const out = redactValue(a);
	assert.equal(out.self, "[circular]");
});

test("the redacting logger masks strings and objects passed to console", () => {
	const captured = [];
	const log = redactingLogger((...args) => captured.push(args));
	log(`[cloud-mode] token=${PLANTED.ghToken}`, { header: `Authorization: Bearer ${PLANTED.jwt}` });
	const flat = JSON.stringify(captured);
	assert.ok(!flat.includes(PLANTED.ghToken), "token reached the log sink");
	assert.ok(!flat.includes(PLANTED.jwt), "JWT reached the log sink");
	assert.match(flat, /redacted github-token/);
});

test("short and non-string values are passed through safely", () => {
	assert.equal(redactString("short"), "short");
	assert.equal(redactValue(42), 42);
	assert.equal(redactValue(null), null);
	assert.equal(redactValue(undefined), undefined);
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the out-of-process agent boundary. See docs/agent-isolation.md.
 *
 * Three things are asserted here, and each is a security property rather than a
 * behaviour:
 *   1. The IPC vocabulary is narrow and hostile input cannot exhaust the host.
 *   2. The model proxy signs only what it should: POST, allow-listed paths, valid
 *      bearer token, and *only the pinned model*.
 *   3. The spawn command actually crosses the uid boundary and carries no
 *      credential-bearing environment across it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	CHILD_MESSAGES,
	createLineDecoder,
	encodeMessage,
	HOST_MESSAGES,
	isExpected,
	MAX_LINE_BYTES,
	sanitizeInit,
} from "../worker/agent-ipc.mjs";
import { evaluateRequest, modelIdFromPath, PROXY_ACCESS_KEY_ID, startModelProxy } from "../worker/model-proxy.mjs";
import { agentIsolationRequested, agentIsolationRequired, buildChildCommand } from "../worker/agent-host.mjs";

// ── 1. IPC protocol ─────────────────────────────────────────────────────────

test("the IPC vocabulary contains no message that could ask for a secret or a git action", () => {
	// The narrowness IS the control: delivery stays in the orchestrator, so the
	// prompt-level "do not use git" becomes structural.
	const all = [...CHILD_MESSAGES, ...HOST_MESSAGES];
	for (const forbidden of ["secret", "token", "git", "push", "merge", "pull_request", "credential", "exec"]) {
		assert.ok(
			!all.some((t) => t.includes(forbidden)),
			`IPC surface must not expose '${forbidden}': ${all.join(" ")}`,
		);
	}
	assert.deepEqual(HOST_MESSAGES, ["init", "prompt", "interrupt", "shutdown"]);
});

test("messages are framed one per line and decoded in order", () => {
	const seen = [];
	const feed = createLineDecoder((m) => seen.push(m));
	feed(encodeMessage({ type: "event", event: { type: "a" } }));
	feed(encodeMessage({ type: "turn_done", turnId: "t1", ok: true }));
	assert.deepEqual(
		seen.map((m) => m.type),
		["event", "turn_done"],
	);
});

test("a message split across chunks is reassembled", () => {
	const seen = [];
	const feed = createLineDecoder((m) => seen.push(m));
	const line = encodeMessage({ type: "event", event: { text: "hello world" } });
	feed(line.slice(0, 10));
	feed(line.slice(10));
	assert.equal(seen.length, 1);
	assert.equal(seen[0].event.text, "hello world");
});

test("malformed and type-less lines are dropped, not fatal", () => {
	const seen = [];
	const problems = [];
	const feed = createLineDecoder(
		(m) => seen.push(m),
		(p) => problems.push(p),
	);
	feed("not json\n");
	feed('{"no":"type"}\n');
	feed(encodeMessage({ type: "event", event: {} }));
	assert.equal(seen.length, 1, "the valid message after the garbage must still arrive");
	assert.equal(problems.length, 2);
});

test("an oversized line is refused rather than growing host memory", () => {
	const problems = [];
	const seen = [];
	const feed = createLineDecoder(
		(m) => seen.push(m),
		(p) => problems.push(p),
	);
	// No newline: a hostile child could stream forever.
	feed("x".repeat(MAX_LINE_BYTES + 1024));
	assert.match(problems.join(" "), /refused an IPC line larger/);
	// The stream recovers for subsequent, well-formed messages.
	feed("\n");
	feed(encodeMessage({ type: "event", event: { ok: true } }));
	assert.equal(seen.length, 1);
});

test("encodeMessage refuses to send an oversized message", () => {
	assert.throws(() => encodeMessage({ type: "event", event: { blob: "y".repeat(MAX_LINE_BYTES) } }), /exceeds/);
});

test("direction is enforced: a child cannot send host-only messages", () => {
	assert.equal(isExpected({ type: "prompt" }, "child"), false);
	assert.equal(isExpected({ type: "event" }, "child"), true);
	assert.equal(isExpected({ type: "event" }, "host"), false);
	assert.equal(isExpected({ type: "shutdown" }, "host"), true);
	assert.equal(isExpected({ type: "give_me_the_token" }, "host"), false);
});

test("sanitizeInit keeps only contract fields", () => {
	const out = sanitizeInit({
		cwd: "/w",
		model: "m",
		provider: "amazon-bedrock",
		proxy: { url: "http://127.0.0.1:1", token: "t", extra: "no" },
		awsSecretAccessKey: "should-not-survive",
		nested: { evil: true },
	});
	assert.deepEqual(Object.keys(out).sort(), ["cwd", "model", "Provider".toLowerCase(), "proxy", "sandbox", "systemPrompt"].sort());
	assert.equal(out.awsSecretAccessKey, undefined);
	assert.deepEqual(Object.keys(out.proxy), ["url", "token"]);
});

// ── 2. Model proxy policy ───────────────────────────────────────────────────

const PINNED = "global.anthropic.claude-opus-5";
const TOKEN = "correct-horse-battery-staple-token";

function evaluate(overrides = {}) {
	return evaluateRequest({
		method: "POST",
		url: `/model/${encodeURIComponent(PINNED)}/converse`,
		authorization: `Bearer ${TOKEN}`,
		expectedToken: TOKEN,
		pinnedModel: PINNED,
		...overrides,
	});
}

test("a well-formed request for the pinned model is proxied", () => {
	assert.equal(evaluate().ok, true);
	assert.equal(evaluate({ url: `/model/${encodeURIComponent(PINNED)}/invoke` }).ok, true);
	assert.equal(evaluate({ url: `/model/${encodeURIComponent(PINNED)}/invoke-with-response-stream` }).ok, true);
});

test("a request for any other model is refused — no switching to a pricier one", () => {
	const verdict = evaluate({ url: "/model/anthropic.claude-3-opus/converse" });
	assert.equal(verdict.ok, false);
	assert.equal(verdict.status, 403);
	assert.match(verdict.reason, /pinned model/);
});

test("a missing, wrong or truncated token is refused", () => {
	for (const authorization of [undefined, "", "Bearer ", "Bearer wrong", `Bearer ${TOKEN.slice(0, -1)}`, TOKEN, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/x, Signature=" + "c".repeat(64)]) {
		const verdict = evaluate({ authorization });
		assert.equal(verdict.ok, false, `token '${authorization}' must not be accepted`);
		assert.equal(verdict.status, 403);
	}
});

test("an SDK's SigV4 header is accepted only with the proxy's dummy key id", () => {
	const sig = "a".repeat(64);
	const good = `AWS4-HMAC-SHA256 Credential=${PROXY_ACCESS_KEY_ID}/20260101/eu-central-1/bedrock/aws4_request, SignedHeaders=host, Signature=${sig}`;
	assert.equal(evaluate({ authorization: good }).ok, true);
	// A real AWS key id must not be honoured: that would make the proxy a signing
	// oracle for whatever credential a caller already had.
	const bad = good.replace(PROXY_ACCESS_KEY_ID, "AKIAIOSFODNN7EXAMPLE");
	assert.equal(evaluate({ authorization: bad }).ok, false);
	// A header without a signature is not a credential.
	assert.equal(evaluate({ authorization: `AWS4-HMAC-SHA256 Credential=${PROXY_ACCESS_KEY_ID}/x` }).ok, false);
});

test("model pinning still applies to SigV4-authenticated requests", () => {
	const sig = "b".repeat(64);
	const auth = `AWS4-HMAC-SHA256 Credential=${PROXY_ACCESS_KEY_ID}/20260101/eu-central-1/bedrock/aws4_request, SignedHeaders=host, Signature=${sig}`;
	const verdict = evaluate({ authorization: auth, url: "/model/some.other.model/converse" });
	assert.equal(verdict.ok, false);
	assert.match(verdict.reason, /pinned model/);
});

test("only POST is proxied, and only model-invocation paths", () => {
	assert.equal(evaluate({ method: "GET" }).status, 405);
	assert.equal(evaluate({ method: "PUT" }).status, 405);
	// The proxy must not become a general-purpose signed-request oracle.
	for (const url of ["/", "/model", "/foo", "/model/x/../../secret", "/secretsmanager/GetSecretValue"]) {
		assert.equal(evaluate({ url }).status, 404, `path '${url}' must not be signed`);
	}
});

test("modelIdFromPath decodes the model id", () => {
	assert.equal(modelIdFromPath(`/model/${encodeURIComponent(PINNED)}/converse`), PINNED);
	assert.equal(modelIdFromPath("/nope"), undefined);
});

test("the running proxy binds loopback, enforces the token, and forwards signed bodies", async () => {
	const forwarded = [];
	const proxy = await startModelProxy({
		pinnedModel: PINNED,
		region: "eu-central-1",
		credentials: async () => ({ accessKeyId: "a", secretAccessKey: "b" }),
		forward: async (args) => {
			forwarded.push(args);
			return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') };
		},
	});
	try {
		assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/, "the proxy must bind loopback only");
		assert.ok(proxy.token.length >= 32, "the bearer token must be high-entropy");

		const path = `/model/${encodeURIComponent(PINNED)}/converse`;
		// Happy path.
		const ok = await fetch(`${proxy.url}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
			body: JSON.stringify({ messages: [] }),
		});
		assert.equal(ok.status, 200);
		assert.equal(await ok.text(), '{"ok":true}');
		assert.equal(forwarded.length, 1);
		assert.equal(forwarded[0].path, path);

		// No token → refused, and nothing is forwarded (so nothing gets signed).
		const noToken = await fetch(`${proxy.url}${path}`, { method: "POST", body: "{}" });
		assert.equal(noToken.status, 403);

		// Wrong model → refused even with a valid token.
		const wrongModel = await fetch(`${proxy.url}/model/other.model/converse`, {
			method: "POST",
			headers: { authorization: `Bearer ${proxy.token}` },
			body: "{}",
		});
		assert.equal(wrongModel.status, 403);

		// A credential-ish path → refused.
		const oracle = await fetch(`${proxy.url}/secretsmanager/GetSecretValue`, {
			method: "POST",
			headers: { authorization: `Bearer ${proxy.token}` },
			body: "{}",
		});
		assert.equal(oracle.status, 404);

		assert.equal(forwarded.length, 1, "only the legitimate request may reach the signer");
	} finally {
		await proxy.close();
	}
});

// ── 3. The spawn actually crosses the boundary ──────────────────────────────

test("the child command carries no credential-bearing environment across the boundary", () => {
	const { args, env } = buildChildCommand();
	// In separate-uid mode the allow-listed environment is materialised into the
	// `env -i` argv; in the degraded same-uid fallback it is the env object. The
	// boundary claim must hold in BOTH, so both are flattened and checked.
	const flat = [...args, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)].join(" ");
	// Nothing Cloud-Mode-ish crosses in the environment at all: the proxy
	// capability travels over the private stdio channel (`init`), because an
	// environment variable is readable by every descendant of the child.
	assert.ok(!/CLOUD_MODE_/.test(flat), `no CLOUD_MODE_* variable may cross: ${flat.slice(0, 200)}`);
	for (const forbidden of [
		"AWS_ACCESS_KEY_ID=",
		"AWS_SECRET_ACCESS_KEY=",
		"AWS_SESSION_TOKEN=",
		"AWS_CONTAINER_AUTHORIZATION_TOKEN=",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI=",
		"GH_TOKEN=",
		"CLOUD_MODE_GIT_TOKEN=",
	]) {
		assert.ok(!flat.includes(forbidden), `${forbidden} must not cross the agent boundary`);
	}
	assert.match(flat, /agent-child\.mjs/, "the child entry point must be what runs");
	// HOME/USER are the unprivileged user's, i.e. the command really is the
	// dropped-privilege form rather than a plain node spawn.
	assert.match(flat, /USER=cmagent/);
});

test("the proxy capability is delivered over IPC, not the environment", () => {
	const init = sanitizeInit({ cwd: "/w", model: "m", proxy: { url: "http://127.0.0.1:9", token: "cap" } });
	assert.equal(init.proxy.url, "http://127.0.0.1:9");
	assert.equal(init.proxy.token, "cap");
	const line = encodeMessage({ type: "init", ...init });
	assert.ok(line.endsWith("\n"), "IPC messages are newline-framed");
});

test("isolation mode is opt-in and its enforcement is opt-in separately", () => {
	assert.equal(agentIsolationRequested({}), false, "default stays in-process until verified on a deployment");
	assert.equal(agentIsolationRequested({ CLOUD_MODE_AGENT_OUT_OF_PROCESS: "1" }), true);
	assert.equal(agentIsolationRequested({ CLOUD_MODE_AGENT_OUT_OF_PROCESS: "0" }), false);
	assert.equal(agentIsolationRequired({}), false);
	assert.equal(agentIsolationRequired({ CLOUD_MODE_REQUIRE_AGENT_ISOLATION: "1" }), true);
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * In-container assertions for the out-of-process agent boundary.
 *
 * Runs INSIDE the built worker image, as the orchestrator user, with credential
 * canaries in the environment. Everything asserted here is a property of the real
 * image — the uid, the `setpriv` path, the file modes — which a host unit test
 * cannot check.
 *
 * Launched by tests/agent-isolation-container.sh.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { initSandbox, sandboxState, untrustedCommand } from "/app/sandbox.mjs";
import { buildChildCommand } from "/app/agent-host.mjs";
import { evaluateRequest, PROXY_ACCESS_KEY_ID, startModelProxy } from "/app/model-proxy.mjs";

let failures = 0;
const ok = (m) => console.log(`ok: ${m}`);
const fail = (m) => {
	failures += 1;
	console.error(`FAIL: ${m}`);
};
const check = (cond, m) => (cond ? ok(m) : fail(m));

// ── 0. The sandbox must actually be able to drop privilege in this image ─────
const sandbox = await initSandbox({ log: () => {} });
check(sandbox.mode === "separate-uid", `sandbox mode is separate-uid (got: ${sandbox.mode}${sandbox.reason ? ` — ${sandbox.reason}` : ""})`);
if (sandbox.mode !== "separate-uid") {
	console.error("cannot verify the agent boundary without privilege separation; aborting");
	process.exit(1);
}

/** Async variant, required whenever something in THIS process must answer the child. */
async function runAsAgentAsync(script) {
	const { file, args, env } = untrustedCommand(script);
	try {
		const { stdout, stderr } = await execFileAsync(file, args, { env, encoding: "utf8" });
		return `${stdout}${stderr}`;
	} catch (err) {
		return `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
}

/** Run a command through the agent child's own spawn path and capture output. */
function runAsAgent(script) {
	const { file, args, env } = untrustedCommand(script);
	try {
		return execFileSync(file, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		return `${err.stdout ?? ""}${err.stderr ?? ""}`;
	}
}

// ── 1. The child really runs unprivileged ───────────────────────────────────
const whoami = runAsAgent("id -un; id -u").trim().split("\n");
check(whoami[0] === "cmagent", `agent child runs as cmagent (got: ${whoami[0]})`);
check(whoami[1] !== "0", `agent child uid is not root (got: ${whoami[1]})`);

// The command the supervisor actually builds must be the dropped form and must
// point at the real child entry point shipped in the image.
const built = buildChildCommand();
check(built.mode === "separate-uid", `buildChildCommand reports separate-uid (got: ${built.mode})`);
check(
	JSON.stringify(built.args).includes("agent-child.mjs"),
	"the supervisor spawns /app/agent-child.mjs",
);
check(
	/setpriv|runuser|sudo/.test(built.file) || JSON.stringify(built.args).includes("setpriv"),
	`the spawn goes through a privilege-drop wrapper (file: ${built.file})`,
);

// ── 2. The orchestrator's environment is unreachable from the child ──────────
const environ = runAsAgent("cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; true");
check(!environ.includes("secretleakcanary"), "child cannot read the orchestrator's AWS secret via /proc");
check(!environ.includes("ghs_leakcanary"), "child cannot read the orchestrator's GitHub token via /proc");
check(!environ.includes("brokerleakcanary"), "child cannot read the credential broker's token via /proc");

// ── 3. No credential-bearing variable crosses into the child ────────────────
const childEnv = runAsAgent("env");
for (const canary of [
	"secretleakcanary",
	"sessionleakcanary",
	"brokerleakcanary",
	"ghs_leakcanary",
	"ghs_leakcanary2",
	"ASIALEAKCANARY",
]) {
	check(!childEnv.includes(canary), `canary '${canary}' does not cross into the child environment`);
}
for (const prefix of ["AWS_", "GH_", "CLOUD_MODE_", "PI_"]) {
	const leaked = childEnv
		.split("\n")
		.map((l) => l.split("=")[0])
		.filter((k) => k.startsWith(prefix));
	check(leaked.length === 0, `no ${prefix}* variable crosses into the child (leaked: ${leaked.join(",") || "none"})`);
}

// ── 4. The token store and the clone's .git stay orchestrator-only ──────────
const tokenDir = join(homedir(), ".cloud-mode");
mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
chmodSync(tokenDir, 0o700);
writeFileSync(join(tokenDir, "askpass.sh"), "#!/bin/sh\necho $CLOUD_MODE_GIT_TOKEN\n", { mode: 0o700 });
const tokenRead = runAsAgent(`cat ${tokenDir}/askpass.sh 2>&1; true`);
check(!tokenRead.includes("CLOUD_MODE_GIT_TOKEN"), "child cannot read the orchestrator's askpass helper");

const repo = "/tmp/boundary-repo";
execFileSync("/bin/bash", ["-c", `rm -rf ${repo} && mkdir -p ${repo} && cd ${repo} && git init -q . && echo hi > f.txt`]);
execFileSync("/bin/bash", ["-c", `chmod -R o-rwx ${repo}/.git`]);
const gitRead = runAsAgent(`cat ${repo}/.git/config 2>&1; true`);
check(/Permission denied|No such file/.test(gitRead), "child cannot read the clone's .git/config");
// Assert the PROPERTY, not the wording: a failed redirection makes bash exit
// non-zero but it does not always print a message, so the rc plus the absence of
// the file is what actually proves the hook could not be planted.
const hookWrite = runAsAgent(`echo '#!/bin/sh' > ${repo}/.git/hooks/pre-commit 2>&1; echo "rc=$?"`);
check(/rc=[1-9]/.test(hookWrite), `child's hook write failed (output: ${JSON.stringify(hookWrite.trim())})`);
let hookPlanted = true;
try {
	execFileSync("/bin/bash", ["-c", `test -f ${repo}/.git/hooks/pre-commit`]);
} catch {
	hookPlanted = false;
}
check(!hookPlanted, "no git hook exists after the child's attempt");

// ── 5. The model proxy enforces its policy inside the image ─────────────────
const PINNED = process.env.PI_MODEL ?? "global.anthropic.claude-opus-5";
let forwarded = 0;
const proxy = await startModelProxy({
	pinnedModel: PINNED,
	region: "eu-central-1",
	credentials: async () => ({ accessKeyId: "dummy", secretAccessKey: "dummy" }),
	forward: async () => {
		forwarded += 1;
		return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') };
	},
});
try {
	check(proxy.url.startsWith("http://127.0.0.1:"), `model proxy binds loopback only (${proxy.url})`);

	const path = `/model/${encodeURIComponent(PINNED)}/converse`;
	const call = async (headers) =>
		(await fetch(`${proxy.url}${path}`, { method: "POST", headers, body: "{}" })).status;

	check((await call({})) === 403, "proxy refuses a request with no capability");
	check((await call({ authorization: "Bearer wrong" })) === 403, "proxy refuses a wrong capability");
	check((await call({ authorization: `Bearer ${proxy.token}` })) === 200, "proxy accepts the real capability");

	const otherModel = await fetch(`${proxy.url}/model/anthropic.claude-3-haiku/converse`, {
		method: "POST",
		headers: { authorization: `Bearer ${proxy.token}` },
		body: "{}",
	});
	check(otherModel.status === 403, "proxy refuses a model other than the pinned one");

	const oracle = await fetch(`${proxy.url}/secretsmanager/GetSecretValue`, {
		method: "POST",
		headers: { authorization: `Bearer ${proxy.token}` },
		body: "{}",
	});
	check(oracle.status === 404, "proxy is not a general-purpose signing oracle");

	check(forwarded === 1, `only the authorised request reached the signer (forwarded: ${forwarded})`);

	// The child reaches the proxy over loopback with the dummy SigV4 identity.
	const sig = "d".repeat(64);
	const sdkAuth = `AWS4-HMAC-SHA256 Credential=${PROXY_ACCESS_KEY_ID}/20260101/eu-central-1/bedrock/aws4_request, SignedHeaders=host, Signature=${sig}`;
	check(evaluateRequest({ method: "POST", url: path, authorization: sdkAuth, expectedToken: proxy.token, pinnedModel: PINNED }).ok, "an SDK inside the child can authenticate with the dummy identity");

	// Must be ASYNC: the proxy runs in THIS process, so a synchronous child-process
	// call would block the event loop and deadlock against its own server.
	const reachable = (await runAsAgentAsync(
		`curl -s -o /dev/null -w '%{http_code}' -X POST -H 'authorization: Bearer ${proxy.token}' ${proxy.url}${path} -d '{}' 2>&1; true`,
	)).trim();
	check(reachable === "200", `the unprivileged child can reach the proxy over loopback (got: ${reachable})`);
} finally {
	await proxy.close();
}

// ── summary ────────────────────────────────────────────────────────────────
console.log(`\nsandbox: ${JSON.stringify(sandboxState())}`);
if (failures > 0) {
	console.error(`\n${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("\nall agent-boundary assertions passed");

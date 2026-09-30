// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * In-container assertions for the worker's isolation boundaries. Executed by
 * tests/sandbox-container.sh inside the built arm64 image (never against AWS).
 *
 * Verifies, using the real modules from /app:
 *   - the untrusted-execution boundary really drops to another OS user;
 *   - that user can write the worktree but not the clone's .git or the .git
 *     pointer (so it cannot plant hooks that would run as the orchestrator);
 *   - the orchestrator can still commit what the untrusted user produced, and
 *     its own files stay writable for the untrusted user;
 *   - the validation gate (repository-supplied code) runs as that user with no
 *     credentials in scope;
 *   - pi's Bedrock provider gate is satisfied by the loopback credential broker
 *     with NO credential in the environment.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const PI_ENV_API_KEYS =
	"/app/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/env-api-keys.js";

const fail = (msg) => {
	console.log(`FAIL: ${msg}`);
	process.exit(1);
};
const ok = (msg) => console.log(`ok: ${msg}`);

const { initSandbox, grantUntrustedAccess, runUntrusted } = await import("/app/sandbox.mjs");
const { makeValidator } = await import("/app/validate.mjs");
const identity = await import("/app/aws-identity.mjs");

// ── the execution boundary ───────────────────────────────────────────────────
const state = await initSandbox({ log: (m) => console.log(m) });
if (state.mode !== "separate-uid") fail(`sandbox mode ${state.mode} (${state.reason})`);
ok("sandbox mode separate-uid");

// ── a real clone + worktree ──────────────────────────────────────────────────
const root = mkdtempSync(`${tmpdir()}/cm-`);
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" });
const origin = `${root}/origin`;
const work = `${root}/work`;
const wt = `${root}/story-S1`;
git(["init", "-q", "--bare", origin]);
git(["clone", "-q", origin, work]);
git(["-C", work, "config", "user.email", "t@t"]);
git(["-C", work, "config", "user.name", "t"]);
writeFileSync(`${work}/README.md`, "seed\n");
git(["-C", work, "add", "-A"]);
git(["-C", work, "commit", "-qm", "seed"]);
git(["-C", work, "branch", "-M", "main"]);
git(["-C", work, "worktree", "add", "-q", "-b", "feature/S1", wt, "main"]);
await grantUntrustedAccess({ traverse: [root], paths: [wt], deny: [`${wt}/.git`], log: (m) => console.log(m) });

// The untrusted user can create files in the worktree...
const r1 = await runUntrusted("id -un > ./agent-file.txt && echo x >> README.md", { cwd: wt });
if (!r1.ok) fail(`untrusted write in worktree: ${r1.output}`);
if (readFileSync(`${wt}/agent-file.txt`, "utf8").trim() !== "cmagent") fail("file not created by cmagent");
ok("untrusted user writes worktree files as cmagent");

// ...but cannot touch the clone (.git, hooks) or redirect the git directory.
if ((await runUntrusted(`echo pwned > ${work}/.git/hooks/pre-commit`, { cwd: wt })).ok) {
	fail("cmagent wrote a git hook");
}
ok("clone/.git not writable by cmagent");
if ((await runUntrusted("echo gitdir: /tmp/evil > .git", { cwd: wt })).ok) {
	fail("cmagent rewrote the worktree .git pointer");
}
ok("worktree .git pointer not writable by cmagent");

// ...and the orchestrator can still commit what the untrusted user produced.
git(["-C", wt, "add", "-A"]);
git(["-C", wt, "commit", "-qm", "agent work"]);
ok("orchestrator committed agent-created files");

// Files the ORCHESTRATOR writes (pi's edit/write tools) must stay writable for
// the untrusted user, or a `prettier --write`-style gate step would fail.
process.umask(0o002);
writeFileSync(`${wt}/orchestrator-file.txt`, "written by node\n");
const r4 = await runUntrusted("echo appended >> orchestrator-file.txt", { cwd: wt });
if (!r4.ok) fail(`untrusted user cannot modify an orchestrator-created file: ${r4.output}`);
ok("orchestrator-created files stay writable for the untrusted user");

// ── the validation gate (repository-supplied code) ───────────────────────────
const res = await makeValidator(wt, { log: (m) => console.log(m) })();
if (!res.ok) fail(`gate failed: ${res.output}`);
if (!/^cmagent$/m.test(res.output)) fail(`gate did not run as cmagent: ${res.output}`);
for (const canary of ["ASIALEAKCANARY", "secretleakcanary", "ghs_leakcanary"]) {
	if (res.output.includes(canary)) fail(`${canary} leaked into the gate`);
}
ok("validation gate ran as cmagent with no credentials in scope");

// ── the credential boundary ─────────────────────────────────────────────────
const piGate = await import(PI_ENV_API_KEYS);
const broker = await identity.startAgentCredentialBroker({
	agentRoleArn: "arn:aws:iam::123456789012:role/agent",
	assumeRole: async () => ({
		accessKeyId: "A",
		secretAccessKey: "S",
		sessionToken: "T",
		expiration: new Date(Date.now() + 3600e3),
	}),
});
const gate = piGate.getEnvApiKey("amazon-bedrock");
if (gate !== "<authenticated>") fail(`pi provider gate not satisfied: ${gate}`);
if (identity.staticCredentialEnvVars().length > 0) fail("credentials present in process.env");
ok("pi accepts the loopback broker with no credential env vars");

const leak = await runUntrusted("env | grep -c '^AWS_' || true", { cwd: wt });
if (!/^0$/m.test(leak.output.trim())) fail(`AWS_* visible to untrusted code: ${leak.output}`);
ok("untrusted code sees no AWS_* variables at all");
await broker.stop();

console.log("all in-container assertions passed");

// ── Image completeness: every worker module must be present in /app ─────────
// A module missing from the Dockerfile's explicit COPY list only fails when the
// container starts, i.e. after a deploy — exactly the failure this catches.
// Checked statically (no import), because importing server.mjs would start the
// HTTP server and the isolation bootstrap.
const { readdirSync, readFileSync: readF } = await import("node:fs");
const shipped = new Set(readdirSync("/app").filter((f) => f.endsWith(".mjs")));
for (const required of [
	"server.mjs",
	"git.mjs",
	"git-auth.mjs",
	"secrets.mjs",
	"integrate.mjs",
	"llm-resolver.mjs",
	"llm-repair.mjs",
	"validate.mjs",
	"aws-identity.mjs",
	"sandbox.mjs",
	"hub.mjs",
	"session-guard.mjs",
	"transcript-archive.mjs",
]) {
	if (!shipped.has(required)) fail(`${required} is missing from the image (Dockerfile COPY list)`);
}
// Every relative import in every shipped module must resolve inside the image.
for (const file of shipped) {
	const src = readF(`/app/${file}`, "utf8");
	for (const m of src.matchAll(/from\s+["'](\.\/[^"']+)["']/g)) {
		const target = m[1].replace("./", "");
		if (!shipped.has(target)) fail(`${file} imports ${m[1]}, which is not in the image`);
	}
}
ok(`all ${shipped.size} worker modules present in the image with resolvable imports`);

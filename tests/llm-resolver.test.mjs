// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * LLM-backed conflict resolver tests (worker/llm-resolver.mjs).
 *
 * The network/model call itself is not exercised here; instead we test:
 *   - parseResolution(): the strict output contract (resolved block, UNRESOLVABLE
 *     verdict, malformed/hallucinated responses) — this is the safety boundary.
 *   - integrateToMain() driving a *custom* (fake LLM) resolver end-to-end against
 *     real git, proving the resolver contract is honored, that a resolver-declared
 *     contradiction aborts loudly, and that a throwing resolver never lands a tree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseResolution } from "../worker/llm-resolver.mjs";
import { integrateToMain } from "../worker/integrate.mjs";

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
const silent = () => {};
const noSleep = async () => {};

function repo(baseFiles) {
	const root = mkdtempSync(join(tmpdir(), "llm-resolve-"));
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	git(root, "init", "--bare", "--initial-branch=main", origin);
	git(root, "clone", origin, work);
	git(work, "config", "user.email", "a@a.com");
	git(work, "config", "user.name", "Agent A");
	for (const [f, c] of Object.entries(baseFiles)) writeFileSync(join(work, f), c);
	git(work, "add", "-A");
	git(work, "commit", "-m", "base");
	git(work, "push", "origin", "main");
	return { root, origin, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function otherAgentPush(origin, parent, name, mutate) {
	const dir = join(parent, `other-${name}`);
	git(parent, "clone", origin, dir);
	git(dir, "config", "user.email", `${name}@x.com`);
	git(dir, "config", "user.name", name);
	mutate(dir);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", `by ${name}`);
	git(dir, "push", "origin", "main");
	rmSync(dir, { recursive: true, force: true });
}

// ── parseResolution: the safety contract ─────────────────────────────────────

test("parseResolution: extracts the merged file from the sentinel block", () => {
	const text = `sure!\n===BEGIN_RESOLVED===\nline1\nline2\n===END_RESOLVED===\ndone`;
	const r = parseResolution(text, "f.txt");
	assert.equal(r.resolved, "line1\nline2\n");
});

test("parseResolution: UNRESOLVABLE verdict → contradiction with reason", () => {
	const r = parseResolution("UNRESOLVABLE: both set version to different values", "f.txt");
	assert.ok(r.conflict);
	assert.equal(r.conflict.reason, "llm-unresolvable");
	assert.match(r.conflict.message, /different values/);
});

test("parseResolution: response with residual conflict markers is rejected", () => {
	const text = `===BEGIN_RESOLVED===\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n===END_RESOLVED===`;
	const r = parseResolution(text, "f.txt");
	assert.ok(r.conflict);
	assert.equal(r.conflict.reason, "llm-markers-remain");
});

test("parseResolution: missing block → no-output conflict", () => {
	const r = parseResolution("I think you should merge them manually.", "f.txt");
	assert.ok(r.conflict);
	assert.equal(r.conflict.reason, "llm-no-output");
});

test("parseResolution: unterminated block → truncated conflict", () => {
	const r = parseResolution("===BEGIN_RESOLVED===\nhalf a file", "f.txt");
	assert.ok(r.conflict);
	assert.equal(r.conflict.reason, "llm-truncated");
});

// ── integrateToMain honoring an injected (fake LLM) resolver, real git ───────

test("custom resolver: merged output lands both sides on main", async () => {
	const { origin, root, work, cleanup } = repo({ "registry.txt": "entries = {\n}\n" });
	try {
		otherAgentPush(origin, root, "winner", (dir) =>
			writeFileSync(join(dir, "registry.txt"), 'entries = {\n  "alpha": a,\n}\n'),
		);
		writeFileSync(join(work, "registry.txt"), 'entries = {\n  "beta": b,\n}\n');
		git(work, "add", "-A");
		git(work, "commit", "-m", "add beta");

		// A stand-in "LLM": returns a hand-merged file keeping both entries.
		const resolveConflict = async ({ file }) => {
			assert.equal(file, "registry.txt");
			return { resolved: 'entries = {\n  "alpha": a,\n  "beta": b,\n}\n' };
		};

		const res = await integrateToMain({ cwd: work, resolveConflict, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
		assert.equal(res.ok, true, res.reason);
		git(work, "fetch", "origin", "main");
		const landed = execFileSync("git", ["show", "origin/main:registry.txt"], { cwd: work, encoding: "utf-8" });
		assert.match(landed, /alpha/);
		assert.match(landed, /beta/);
	} finally {
		cleanup();
	}
});

test("custom resolver: declared contradiction aborts loudly, nothing lands", async () => {
	const { origin, root, work, cleanup } = repo({ "config.txt": 'version = "1"\n' });
	try {
		otherAgentPush(origin, root, "winner", (dir) => writeFileSync(join(dir, "config.txt"), 'version = "2"\n'));
		writeFileSync(join(work, "config.txt"), 'version = "3"\n');
		git(work, "add", "-A");
		git(work, "commit", "-m", "bump");

		const resolveConflict = async ({ file }) => ({
			conflict: { reason: "llm-unresolvable", message: "version set two ways", file },
		});
		const res = await integrateToMain({ cwd: work, resolveConflict, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
		assert.equal(res.ok, false);
		assert.equal(res.status, "unresolvable-conflict");
		assert.match(res.reason, /version set two ways/);
		assert.equal(git(work, "status", "--porcelain"), "", "rebase aborted, tree clean");
	} finally {
		cleanup();
	}
});

test("custom resolver: a throwing resolver aborts (never pushes an unresolved tree)", async () => {
	const { origin, root, work, cleanup } = repo({ "x.txt": "a\n" });
	try {
		otherAgentPush(origin, root, "winner", (dir) => writeFileSync(join(dir, "x.txt"), "a\nWINNER\n"));
		writeFileSync(join(work, "x.txt"), "a\nOURS\n");
		git(work, "add", "-A");
		git(work, "commit", "-m", "ours");

		const resolveConflict = async () => {
			throw new Error("bedrock timeout");
		};
		const res = await integrateToMain({ cwd: work, resolveConflict, validate: async () => ({ ok: true }), log: silent, sleep: noSleep });
		assert.equal(res.ok, false);
		assert.equal(res.status, "unresolvable-conflict");
		assert.match(res.reason, /resolver-error|bedrock timeout/);
	} finally {
		cleanup();
	}
});

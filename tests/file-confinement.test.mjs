// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for path confinement of the agent's file tools.
 *
 * The threat these close is specific: pi's read/write/edit/ls/grep/find run
 * in-process with orchestrator privileges, so before this guard an injected
 * agent could read `/proc/self/environ` (historically containing the GitHub
 * token) or rewrite the clone's `.git` — without ever asking for a shell.
 *
 * The suite also asserts the *positive* case: ordinary work inside the worktree
 * still succeeds, because a confinement that breaks the tool would simply be
 * turned off by the next operator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	confinedFileOperations,
	confinedFindOperations,
	makePathGuard,
	PathConfinementError,
} from "../worker/file-confinement.mjs";

/** A worktree that looks like a real clone, plus a secret outside it. */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "cloud-mode-confine-"));
	const worktree = join(root, "worktree");
	mkdirSync(join(worktree, "src"), { recursive: true });
	mkdirSync(join(worktree, ".git", "hooks"), { recursive: true });
	writeFileSync(join(worktree, "src", "app.js"), "export const x = 1;\n");
	writeFileSync(join(worktree, ".git", "config"), "[remote \"origin\"]\n");
	// The things an injected agent actually wants, all outside the worktree.
	const tokenDir = join(root, ".cloud-mode");
	mkdirSync(tokenDir, { recursive: true });
	writeFileSync(join(tokenDir, "askpass.sh"), "#!/bin/sh\necho $CLOUD_MODE_GIT_TOKEN\n");
	writeFileSync(join(root, "secret.txt"), "ghp_pretend_token\n");
	return { root, worktree, tokenDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("reads inside the worktree still work", async () => {
	const f = fixture();
	try {
		const { read } = confinedFileOperations(f.worktree, { extraDenied: [f.tokenDir] });
		const buf = await read.readFile(join(f.worktree, "src", "app.js"));
		assert.match(buf.toString(), /export const x/);
		// Relative paths resolve against the worktree.
		const rel = await read.readFile("src/app.js");
		assert.match(rel.toString(), /export const x/);
	} finally {
		f.cleanup();
	}
});

test("writes and edits inside the worktree still work", async () => {
	const f = fixture();
	try {
		const { write, edit } = confinedFileOperations(f.worktree);
		await write.mkdir(join(f.worktree, "src", "new"));
		await write.writeFile(join(f.worktree, "src", "new", "b.js"), "// hi\n");
		await edit.writeFile(join(f.worktree, "src", "app.js"), "export const x = 2;\n");
		const buf = await edit.readFile(join(f.worktree, "src", "app.js"));
		assert.match(buf.toString(), /x = 2/);
	} finally {
		f.cleanup();
	}
});

test("/proc/self/environ is denied — the credential-theft path", async () => {
	const f = fixture();
	try {
		const { read } = confinedFileOperations(f.worktree);
		await assert.rejects(() => read.readFile("/proc/self/environ"), PathConfinementError);
		await assert.rejects(() => read.readFile("/proc/self/cmdline"), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("the clone's .git directory is denied for read and write", async () => {
	const f = fixture();
	try {
		const { read, write, edit } = confinedFileOperations(f.worktree);
		await assert.rejects(() => read.readFile(join(f.worktree, ".git", "config")), PathConfinementError);
		await assert.rejects(
			() => write.writeFile(join(f.worktree, ".git", "hooks", "pre-commit"), "#!/bin/sh\n"),
			PathConfinementError,
		);
		await assert.rejects(() => edit.readFile(join(f.worktree, ".git", "config")), PathConfinementError);
		// Relative traversal into .git is the same rule.
		await assert.rejects(() => read.readFile(".git/config"), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("paths outside the worktree are denied, including .. traversal", async () => {
	const f = fixture();
	try {
		const { read, write } = confinedFileOperations(f.worktree, { extraDenied: [f.tokenDir] });
		await assert.rejects(() => read.readFile(join(f.root, "secret.txt")), PathConfinementError);
		await assert.rejects(() => read.readFile("../secret.txt"), PathConfinementError);
		await assert.rejects(() => read.readFile("src/../../secret.txt"), PathConfinementError);
		await assert.rejects(() => write.writeFile(join(f.root, "planted.js"), "x"), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("the askpass/token directory is denied even though it is a normal directory", async () => {
	const f = fixture();
	try {
		const { read } = confinedFileOperations(f.worktree, { extraDenied: [f.tokenDir] });
		await assert.rejects(() => read.readFile(join(f.tokenDir, "askpass.sh")), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("a symlink pointing out of the worktree does not escape the guard", async () => {
	const f = fixture();
	try {
		symlinkSync(join(f.root, "secret.txt"), join(f.worktree, "link-to-secret"));
		symlinkSync(f.root, join(f.worktree, "link-to-root"));
		const { read } = confinedFileOperations(f.worktree);
		await assert.rejects(() => read.readFile(join(f.worktree, "link-to-secret")), PathConfinementError);
		await assert.rejects(() => read.readFile(join(f.worktree, "link-to-root", "secret.txt")), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("a new file in a not-yet-existing subdirectory is still normalised and allowed", () => {
	const f = fixture();
	try {
		const guard = makePathGuard(f.worktree);
		const target = guard(join(f.worktree, "does", "not", "exist", "yet.txt"), { operation: "write" });
		assert.ok(target.startsWith(guard(f.worktree)), "resolved target must stay under the worktree");
		// ...but the same trick cannot be used to reach outside.
		assert.throws(() => guard(join(f.worktree, "..", "nope", "x.txt")), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("ls and grep are confined too, not just read/write", async () => {
	const f = fixture();
	try {
		const { ls, grep } = confinedFileOperations(f.worktree);
		assert.ok(Array.isArray(await ls.readdir(join(f.worktree, "src"))));
		await assert.rejects(() => ls.readdir(join(f.worktree, ".git")), PathConfinementError);
		assert.throws(() => ls.exists("/proc"), PathConfinementError);
		await assert.rejects(() => grep.readFile(join(f.root, "secret.txt")), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("find drops hits that resolve outside the worktree", async () => {
	const f = fixture();
	try {
		symlinkSync(join(f.root, "secret.txt"), join(f.worktree, "escaped.txt"));
		const ops = confinedFindOperations(f.worktree);
		const hits = await ops.glob("*.txt", f.worktree, { ignore: [], limit: 50 });
		assert.ok(!hits.includes("escaped.txt"), "a symlinked hit pointing outside must be dropped");
		assert.throws(() => ops.exists("/proc/self"), PathConfinementError);
	} finally {
		f.cleanup();
	}
});

test("the error names the rule, so the transcript shows what was attempted", async () => {
	const f = fixture();
	try {
		const { read } = confinedFileOperations(f.worktree);
		await assert.rejects(
			() => read.readFile("/proc/self/environ"),
			(e) => {
				assert.equal(e.code, "EPATHCONFINED");
				assert.match(e.message, /denied/);
				return true;
			},
		);
	} finally {
		f.cleanup();
	}
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * The static-analysis gate must not be able to become a silent no-op.
 *
 * A ruleset that parses but matches nothing looks exactly like a clean codebase.
 * This test feeds the ruleset a file that deliberately contains one instance of
 * each blocking class and asserts every rule fires — so a broken pattern, a
 * renamed rule id, or an accidentally emptied ruleset fails the build instead of
 * quietly passing it.
 *
 * Skipped (not failed) when no analyzer is installed: that case is the build
 * script's business, and it already fails closed there.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const RULES = new URL("../scripts/sast-rules.yml", import.meta.url).pathname;

function semgrepAvailable() {
	const r = spawnSync("semgrep", ["--version"], { stdio: "ignore" });
	return r.status === 0;
}

/** Rule ids that must block the build, with a snippet that triggers each. */
const BLOCKING_CASES = {
	"cloud-mode-shell-injection": 'execSync(`git clone ${repoUrl}`);',
	"cloud-mode-dynamic-code-execution": "eval(modelOutput);",
	"cloud-mode-hardcoded-secret": 'const password = "hunter2-not-a-real-one";',
	"cloud-mode-weak-randomness-for-secret": "const sessionToken = Math.random().toString(36);",
	"cloud-mode-timing-unsafe-secret-compare": "if (payload.ownerToken === entry.ownerToken) return true;",
	"cloud-mode-tls-verification-disabled": "const agent = { rejectUnauthorized: false };",
	"cloud-mode-plaintext-http": 'const api = "http://api.example.com/v1";',
};

/** Shapes that must NOT fire, so the gate stays usable in real code. */
const CLEAN_CASES = [
	'const ownerToken = typeof payload.ownerToken === "string" ? payload.ownerToken : undefined;',
	'const local = "http://127.0.0.1:8080/callback";',
	"const key = process.env.GH_PRIVATE_KEY_SECRET;",
	'execFile("git", ["clone", repoUrl], opts);',
];

function scan(source, filename = "sample.mjs") {
	const dir = mkdtempSync(join(tmpdir(), "cloud-mode-sast-"));
	try {
		writeFileSync(join(dir, filename), source, "utf-8");
		const out = execFileSync(
			"semgrep",
			["--config", RULES, "--json", "--metrics", "off", "--disable-version-check", "--quiet", dir],
			{ encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
		);
		return JSON.parse(out).results.map((r) => String(r.check_id).split(".").pop());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("every blocking rule fires on a known-bad snippet", { skip: !semgrepAvailable() && "semgrep not installed" }, () => {
	const fired = new Set(scan(Object.values(BLOCKING_CASES).join("\n")));
	for (const id of Object.keys(BLOCKING_CASES)) {
		assert.ok(fired.has(id), `rule '${id}' did not fire — the gate is not enforcing it`);
	}
});

test("triaged shapes do not fire", { skip: !semgrepAvailable() && "semgrep not installed" }, () => {
	assert.deepEqual(scan(CLEAN_CASES.join("\n")), [], "false positive: the gate would block legitimate code");
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for the delegation allow-list (and the
 * accidental-misuse half of the InvokeAgentRuntime ⇒ GitHub-write path).
 *
 * `delegate_story` is invoked by the *model*: the repository it targets comes out
 * of a model turn, and holding `InvokeAgentRuntime` is equivalent to holding
 * GitHub write access. The allow-list is the control that makes "which repo may
 * this project delegate to" an operator decision written down in configuration
 * rather than a model decision made at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, repoAllowed } from "../.pi/extensions/cloud-mode/config.ts";

const CONFIG_DIR = ".pi";

/** Temp project with a cloud-mode.json and a selected repo in state. */
function withProject({ raw = {}, selected = "acme/widgets" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "cloud-mode-allow-"));
	mkdirSync(join(root, CONFIG_DIR), { recursive: true });
	writeFileSync(
		join(root, CONFIG_DIR, "cloud-mode.json"),
		JSON.stringify({
			region: "eu-central-1",
			agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-central-1:1:runtime/x",
			githubOwner: "acme",
			...raw,
		}),
	);
	if (selected) {
		writeFileSync(
			join(root, CONFIG_DIR, "cloud-mode.state.json"),
			JSON.stringify({ repo: { nameWithOwner: selected, url: `https://github.com/${selected}.git`, defaultBranch: "main" } }),
		);
	}
	return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ── matching rules ──────────────────────────────────────────────────────────

test("exact matches are allowed, case-insensitively", () => {
	assert.equal(repoAllowed("acme/widgets", ["acme/widgets"]), true);
	assert.equal(repoAllowed("ACME/Widgets", ["acme/widgets"]), true);
	assert.equal(repoAllowed("acme/widgets", ["ACME/WIDGETS"]), true);
});

test("a different repository is refused even under the same owner", () => {
	assert.equal(repoAllowed("acme/secrets", ["acme/widgets"]), false);
});

test("owner wildcards match within the owner only — never across owners", () => {
	assert.equal(repoAllowed("acme/anything", ["acme/*"]), true);
	assert.equal(repoAllowed("acme/widgets-v2", ["acme/widgets*"]), true);
	assert.equal(repoAllowed("evil/anything", ["acme/*"]), false);
	assert.equal(repoAllowed("evil/widgets", ["acme/widgets"]), false);
});

test("an empty or malformed allow-list allows nothing", () => {
	assert.equal(repoAllowed("acme/widgets", []), false);
	assert.equal(repoAllowed("acme/widgets", ["", "   ", "not-a-repo"]), false);
	assert.equal(repoAllowed("no-slash", ["acme/*"]), false);
});

test("lookalike owners do not match by prefix", () => {
	assert.equal(repoAllowed("acme-evil/widgets", ["acme/*"]), false);
	assert.equal(repoAllowed("acme/widgets", ["acme-evil/*"]), false);
});

// ── configuration defaults ──────────────────────────────────────────────────

test("the default allow-list is exactly the project's selected repository", () => {
	const p = withProject({ selected: "acme/widgets" });
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, true);
		assert.deepEqual(config.delegableRepos, ["acme/widgets"]);
		assert.equal(repoAllowed("acme/widgets", config.delegableRepos), true);
		assert.equal(repoAllowed("acme/other", config.delegableRepos), false);
	} finally {
		p.cleanup();
	}
});

test("an explicit allow-list replaces the default", () => {
	const p = withProject({ raw: { delegableRepos: ["acme/widgets", "acme/tools"] } });
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, true);
		assert.deepEqual(config.delegableRepos, ["acme/widgets", "acme/tools"]);
	} finally {
		p.cleanup();
	}
});

test("garbage entries are dropped rather than silently widening the list", () => {
	const p = withProject({ raw: { delegableRepos: ["acme/widgets", "", 42, "nope", null] } });
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, true);
		assert.deepEqual(config.delegableRepos, ["acme/widgets"]);
	} finally {
		p.cleanup();
	}
});

test("with no repo selected and no config, nothing is delegable", () => {
	const p = withProject({ selected: null });
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, true);
		assert.deepEqual(config.delegableRepos, []);
		assert.equal(repoAllowed("acme/widgets", config.delegableRepos), false);
	} finally {
		p.cleanup();
	}
});

test("an untrusted project reads no allow-list at all", () => {
	const p = withProject({ raw: { delegableRepos: ["acme/*"] } });
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, false);
		assert.deepEqual(config.delegableRepos, []);
	} finally {
		p.cleanup();
	}
});

test("autoConfirm defaults to false and is opt-in per project", () => {
	const off = withProject();
	const on = withProject({ raw: { autoConfirm: true } });
	try {
		assert.equal(loadConfig(off.root, CONFIG_DIR, true).config.autoConfirm, false);
		assert.equal(loadConfig(on.root, CONFIG_DIR, true).config.autoConfirm, true);
	} finally {
		off.cleanup();
		on.cleanup();
	}
});

test("CLOUD_MODE_DELEGABLE_REPOS overrides the file, and autoConfirm never widens it", () => {
	const p = withProject({ raw: { delegableRepos: ["acme/widgets"], autoConfirm: true } });
	process.env.CLOUD_MODE_DELEGABLE_REPOS = "acme/tools, acme/docs";
	try {
		const { config } = loadConfig(p.root, CONFIG_DIR, true);
		assert.deepEqual(config.delegableRepos, ["acme/tools", "acme/docs"]);
		// autoConfirm skips the prompt only; the allow-list still decides.
		assert.equal(config.autoConfirm, true);
		assert.equal(repoAllowed("acme/widgets", config.delegableRepos), false);
	} finally {
		delete process.env.CLOUD_MODE_DELEGABLE_REPOS;
		p.cleanup();
	}
});

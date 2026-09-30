// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Unit tests for cloud-mode config parsing — focused on the new `deliveryMode`
 * field: default, both explicit values, and invalid values.
 *
 * Node 26 strips TypeScript types natively, so we import the extension's
 * config.ts directly. Each case writes a throwaway .pi/cloud-mode.json into a
 * temp dir and loads it as a trusted project.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, parseDeliveryMode, DEFAULT_DELIVERY_MODE } from "../.pi/extensions/cloud-mode/config.ts";

const CONFIG_DIR = ".pi";

/** Create a temp project dir with the given raw cloud-mode.json body. */
function withConfig(raw) {
	const root = mkdtempSync(join(tmpdir(), "cloud-mode-cfg-"));
	mkdirSync(join(root, CONFIG_DIR), { recursive: true });
	writeFileSync(join(root, CONFIG_DIR, "cloud-mode.json"), JSON.stringify(raw), "utf-8");
	return root;
}

const BASE = {
	region: "us-east-1",
	agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:1:runtime/x",
	githubOwner: "acme",
};

// Guard against env overrides leaking into these cases.
for (const k of ["CLOUD_MODE_DELIVERY_MODE", "CLOUD_MODE_REGION", "CLOUD_MODE_RUNTIME_ARN", "CLOUD_MODE_GITHUB_OWNER"]) {
	delete process.env[k];
}

test("deliveryMode defaults to pull-request when absent", () => {
	const root = withConfig(BASE);
	try {
		const { config, error } = loadConfig(root, CONFIG_DIR, true);
		assert.equal(error, undefined);
		assert.equal(config.deliveryMode, "pull-request");
		assert.equal(config.deliveryMode, DEFAULT_DELIVERY_MODE);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deliveryMode accepts explicit pull-request", () => {
	const root = withConfig({ ...BASE, deliveryMode: "pull-request" });
	try {
		const { config, error } = loadConfig(root, CONFIG_DIR, true);
		assert.equal(error, undefined);
		assert.equal(config.deliveryMode, "pull-request");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("deliveryMode accepts explicit direct-merge", () => {
	const root = withConfig({ ...BASE, deliveryMode: "direct-merge" });
	try {
		const { config, error } = loadConfig(root, CONFIG_DIR, true);
		assert.equal(error, undefined);
		assert.equal(config.deliveryMode, "direct-merge");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid deliveryMode is rejected with a clear error", () => {
	const root = withConfig({ ...BASE, deliveryMode: "yolo" });
	try {
		const { error } = loadConfig(root, CONFIG_DIR, true);
		assert.ok(error, "expected an error for an invalid deliveryMode");
		assert.match(error, /Invalid deliveryMode/);
		assert.match(error, /"pull-request"/);
		assert.match(error, /"direct-merge"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("parseDeliveryMode: default / valid / invalid", () => {
	assert.equal(parseDeliveryMode(undefined).mode, "pull-request");
	assert.equal(parseDeliveryMode("").mode, "pull-request");
	assert.equal(parseDeliveryMode("pull-request").mode, "pull-request");
	assert.equal(parseDeliveryMode("direct-merge").mode, "direct-merge");
	const bad = parseDeliveryMode("nope");
	assert.equal(bad.mode, undefined);
	assert.match(bad.error, /Invalid deliveryMode/);
});

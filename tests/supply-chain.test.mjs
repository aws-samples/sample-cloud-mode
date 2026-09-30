// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Supply-chain invariants for the worker image.
 *
 * These exist because of a concrete miss, not a hypothetical one. An ECR scan of
 * the *deployed* worker image reported 4 CRITICAL / 24 HIGH findings while:
 *
 *   - the base-image digest pin was current (so the monthly drift check passed),
 *   - `npm audit` was clean, and
 *   - the CVE was recorded as "installed == candidate, no fixed package yet".
 *
 * Ten of those findings (libssh2, expat, pcre2) had fixed Debian packages
 * available and were absorbed by a plain rebuild. The claim had been true when
 * it was written and quietly went stale — which is control decay applied to the image
 * rather than to our own source.
 *
 * The Dockerfile now refuses to build an image that is behind its own package
 * index. The tests below assert that refusal is still wired up, because a
 * build-time gate that gets dropped in a refactor is invisible: the build simply
 * goes green again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCKERFILE = readFileSync(new URL("../worker/Dockerfile", import.meta.url), "utf8");
const WORKFLOW_DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

test("the image build refuses to ship packages behind their candidate version", () => {
	// The simulated upgrade is the probe; `^Inst` lines are the evidence of a
	// pending fix. Both halves must be present for the gate to mean anything.
	assert.match(
		DOCKERFILE,
		/apt-get\s+-s\s+dist-upgrade/,
		"no simulated dist-upgrade: nothing checks for pending package fixes",
	);
	assert.match(
		DOCKERFILE,
		/grep\s+'\^Inst'/,
		"the simulated upgrade's output is not inspected for pending installs",
	);
	assert.match(DOCKERFILE, /BUILD REFUSED/, "the check does not identify itself in build output");
	assert.match(
		DOCKERFILE,
		/exit 1/,
		"the check reports but does not fail the build — a warning is not a gate",
	);
});

test("the pending-upgrade check runs after every package install, not before", () => {
	// Ordering is the whole point: git/curl/gh pull in dependencies, and those
	// dependencies are what went stale. A check that runs before them proves
	// nothing about the image that actually ships.
	//
	// Comment lines are excluded deliberately: the Dockerfile documents an
	// `apt-get install` example for project toolchains further down, and a
	// commented instruction installs nothing.
	const effective = DOCKERFILE.split("\n")
		.filter((l) => !l.trimStart().startsWith("#"))
		.join("\n");
	const lastInstall = effective.lastIndexOf("apt-get install");
	const check = effective.indexOf("apt-get -s dist-upgrade");
	assert.ok(lastInstall > 0 && check > 0, "expected both an install and the check in the image");
	assert.ok(
		check > lastInstall,
		"the pending-upgrade check must come after the last package install",
	);
});

test("the apt cache is cleaned only after the check has run", () => {
	// `rm -rf /var/lib/apt/lists/*` destroys the index the check needs. If it
	// runs first the check silently sees "nothing pending" and always passes.
	const clean = DOCKERFILE.indexOf("rm -rf /var/lib/apt/lists");
	const check = DOCKERFILE.indexOf("apt-get -s dist-upgrade");
	assert.ok(clean > 0, "expected the apt lists cleanup in the image");
	assert.ok(check < clean, "the apt index is discarded before the pending-upgrade check runs");
});

test("the base image stays pinned by digest", () => {
	// A mutable tag means `cdk deploy` can ship an image nobody reviewed.
	const from = DOCKERFILE.split("\n").find((l) => l.startsWith("FROM "));
	assert.ok(from, "no FROM line in the worker image");
	assert.match(from, /@sha256:[0-9a-f]{64}/, "base image is not pinned by digest");
});

test("a scheduled job exists to surface base-image staleness", () => {
	// The build gate catches "a fix exists and we didn't take it". It cannot
	// catch "the base image itself moved on" — that needs a clock.
	const refresh = readFileSync(`${WORKFLOW_DIR}base-image-refresh.yml`, "utf8");
	assert.match(refresh, /^on:/m, "the refresh workflow has no trigger");
	assert.match(refresh, /schedule:/, "the refresh workflow is not scheduled");
	assert.match(refresh, /cron:/, "the refresh workflow has no cron expression");
});

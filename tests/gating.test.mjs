// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Tests for escape-hatch reporting — "an ungated delivery must say so on its own
 * face".
 *
 * The invariant under test is asymmetric and both halves matter:
 *   - a delivery that bypassed a gate carries the marker in the commit trailer,
 *     the PR body and the operator's stream;
 *   - a normal, fully gated delivery carries NONE of them, so the marker keeps
 *     its meaning.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	clearUngated,
	isUngated,
	markUngated,
	resetUngated,
	ungatedPrBlock,
	ungatedReasons,
	ungatedSummary,
	ungatedTrailer,
	UNGATED_BRANCH_PROTECTION,
	UNGATED_VALIDATION_SKIPPED,
	UNGATED_VALIDATION_UNAVAILABLE,
} from "../worker/gating.mjs";
import { attributionTrailer } from "../worker/git.mjs";
import { makeValidator, SKIP_MARKER } from "../worker/validate.mjs";

test.beforeEach(() => resetUngated());

test("a gated story produces no markers at all", () => {
	assert.equal(isUngated("STORY-clean"), false);
	assert.equal(ungatedTrailer("STORY-clean"), "");
	assert.equal(ungatedPrBlock("STORY-clean"), "");
	assert.equal(ungatedSummary("STORY-clean"), "");
	const trailer = attributionTrailer({ storyId: "STORY-clean", sessionId: "s1", delegatedBy: "arn:aws:iam::1:user/x" });
	assert.ok(!trailer.includes("Cloud-Mode-Ungated"), "clean delivery must not be marked ungated");
	assert.ok(trailer.includes("Cloud-Mode-Story: STORY-clean"));
});

test("a skipped validation gate is stamped into the commit trailer", () => {
	markUngated("STORY-skip", UNGATED_VALIDATION_SKIPPED, "no toolchain for rust");
	const trailer = attributionTrailer({ storyId: "STORY-skip", sessionId: "s2" });
	assert.match(trailer, /Cloud-Mode-Ungated: validation-skipped \(no toolchain for rust\)/);
	// Attribution metadata is still intact alongside it.
	assert.match(trailer, /Cloud-Mode-Story: STORY-skip/);
	assert.match(trailer, /Cloud-Mode-Session: s2/);
});

test("a waived branch-protection precondition is stamped too", () => {
	markUngated("STORY-waive", UNGATED_BRANCH_PROTECTION, "requireBranchProtection: false");
	assert.match(attributionTrailer({ storyId: "STORY-waive" }), /Cloud-Mode-Ungated: branch-protection-waived/);
});

test("both hatches are reported independently and can co-occur", () => {
	markUngated("STORY-both", UNGATED_VALIDATION_SKIPPED, "skipped steps");
	markUngated("STORY-both", UNGATED_BRANCH_PROTECTION, "unverifiable");
	const reasons = ungatedReasons("STORY-both");
	assert.equal(reasons.length, 2);
	const trailer = ungatedTrailer("STORY-both");
	assert.match(trailer, /validation-skipped/);
	assert.match(trailer, /branch-protection-waived/);
});

test("the PR body block is loud, first, and names the reason", () => {
	markUngated("STORY-pr", UNGATED_VALIDATION_SKIPPED, "pnpm missing");
	const block = ungatedPrBlock("STORY-pr");
	assert.match(block, /^> \[!WARNING\]/, "block must start with a GitHub warning callout");
	assert.match(block, /Ungated delivery/);
	assert.match(block, /pnpm missing/);
	assert.match(block, /reviewed by nobody and verified by nothing/);
});

test("markUngated is idempotent per kind and scoped per story", () => {
	markUngated("STORY-a", UNGATED_VALIDATION_SKIPPED, "first");
	markUngated("STORY-a", UNGATED_VALIDATION_SKIPPED, "second");
	assert.equal(ungatedReasons("STORY-a").length, 1);
	assert.equal(ungatedReasons("STORY-a")[0].detail, "first", "first (most specific) reason wins");
	// Concurrent sessions in one container must not bleed into each other.
	assert.equal(isUngated("STORY-b"), false);
});

test("clearUngated releases a finished story's state", () => {
	markUngated("STORY-c", UNGATED_BRANCH_PROTECTION, "x");
	clearUngated("STORY-c");
	assert.equal(isUngated("STORY-c"), false);
});

test("unknown kinds and missing story ids are ignored", () => {
	markUngated("STORY-d", "not-a-kind", "x");
	markUngated(undefined, UNGATED_VALIDATION_SKIPPED, "x");
	assert.equal(isUngated("STORY-d"), false);
});

test("makeValidator records the hatch when an unknown ecosystem is allowed through", async () => {
	const previous = process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
	process.env.CLOUD_MODE_ALLOW_UNVALIDATED = "1";
	try {
		// A directory with no recognised marker file → no validation command exists.
		const validate = makeValidator("/nonexistent-project-dir", { storyId: "STORY-env" });
		const result = await validate();
		assert.equal(result.ok, true);
		assert.equal(result.skipped, true);
		assert.ok(result.output.includes(SKIP_MARKER));
		assert.ok(isUngated("STORY-env"), "an allowed-through gate must mark the story ungated");
		assert.match(ungatedTrailer("STORY-env"), /validation-skipped/);
	} finally {
		if (previous === undefined) delete process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
		else process.env.CLOUD_MODE_ALLOW_UNVALIDATED = previous;
	}
});

test("makeValidator failing closed also records why, without claiming a pass", async () => {
	const previous = process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
	delete process.env.CLOUD_MODE_ALLOW_UNVALIDATED;
	try {
		const validate = makeValidator("/nonexistent-project-dir", { storyId: "STORY-closed" });
		const result = await validate();
		assert.equal(result.ok, false, "fail-closed must stay the default");
		assert.equal(result.unavailable, true);
		assert.equal(
			ungatedReasons("STORY-closed")[0].kind,
			UNGATED_VALIDATION_UNAVAILABLE,
			"the reason is recorded even though no delivery follows",
		);
	} finally {
		if (previous !== undefined) process.env.CLOUD_MODE_ALLOW_UNVALIDATED = previous;
	}
});

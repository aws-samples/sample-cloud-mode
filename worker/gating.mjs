// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Escape-hatch bookkeeping — "an ungated delivery must say so on its own face".
 *
 * Cloud Mode replaces human review of the diff with two machine gates: the
 * worker's validation gate and GitHub's required status checks behind
 * branch protection. Both have documented escape hatches:
 *
 *   - `CLOUD_MODE_ALLOW_UNVALIDATED=1` turns a gate that *could not run* into a
 *     logged pass (`validate.mjs`),
 *   - `requireBranchProtection: false` (or a default branch whose protection
 *     could not be verified) lets the extension launch into an unprotected
 *     branch (`config.ts`, `index.ts`).
 *
 * Before this module, using either produced one log line in a stream that dies
 * with the session — so a merged PR looked identical whether it had been gated
 * or not. Here the fact becomes *delivery metadata*: it travels with the commit
 * (trailer), with the pull request (body block), to the operator while it
 * happens (event), and into the setup status report.
 *
 * State is keyed by `storyId` because one container can host several concurrent
 * sessions (`CLOUD_MODE_MAX_ACTIVE_SESSIONS`), so a module-level flag would leak
 * one story's ungated status onto another's commit.
 */

/** storyId → Map<kind, reason>. Insertion-ordered, so reporting is stable. */
const ungated = new Map();

/** Reasons we consider "this delivery was not fully gated". */
export const UNGATED_VALIDATION_SKIPPED = "validation-skipped";
export const UNGATED_VALIDATION_UNAVAILABLE = "validation-unavailable";
export const UNGATED_BRANCH_PROTECTION = "branch-protection-waived";

const LABELS = {
	[UNGATED_VALIDATION_SKIPPED]: "validation gate skipped (CLOUD_MODE_ALLOW_UNVALIDATED=1)",
	[UNGATED_VALIDATION_UNAVAILABLE]: "validation gate could not run",
	[UNGATED_BRANCH_PROTECTION]: "branch protection / required checks not enforced",
};

/**
 * Record that a gate did not apply to this story. Idempotent per kind: the
 * first, most specific reason wins, so a repeated skip does not stack up.
 */
export function markUngated(storyId, kind, detail) {
	if (!storyId || !LABELS[kind]) return;
	let entry = ungated.get(storyId);
	if (!entry) {
		entry = new Map();
		ungated.set(storyId, entry);
	}
	if (!entry.has(kind)) entry.set(kind, typeof detail === "string" ? detail.trim() : "");
}

/** All recorded reasons for a story as `[{ kind, label, detail }]`. */
export function ungatedReasons(storyId) {
	const entry = ungated.get(storyId);
	if (!entry) return [];
	return [...entry.entries()].map(([kind, detail]) => ({ kind, label: LABELS[kind], detail }));
}

/** True when any gate was bypassed for this story. */
export function isUngated(storyId) {
	return ungatedReasons(storyId).length > 0;
}

/** Drop a finished story's state so a long-lived container does not grow. */
export function clearUngated(storyId) {
	ungated.delete(storyId);
}

/** Visible for tests. */
export function resetUngated() {
	ungated.clear();
}

/** One-line summary used in logs and events. */
export function ungatedSummary(storyId) {
	const reasons = ungatedReasons(storyId);
	if (!reasons.length) return "";
	return reasons.map((r) => (r.detail ? `${r.label}: ${r.detail}` : r.label)).join("; ");
}

/**
 * Commit trailer lines. Appended to the existing attribution trailer so
 * `git log` alone reveals an ungated delivery — the transcript and the PR can
 * both be gone and the commit still tells the truth.
 */
export function ungatedTrailer(storyId) {
	const reasons = ungatedReasons(storyId);
	if (!reasons.length) return "";
	return reasons.map((r) => `Cloud-Mode-Ungated: ${r.kind}${r.detail ? ` (${r.detail})` : ""}`).join("\n");
}

/**
 * Markdown block for the top of the PR body. Deliberately loud and deliberately
 * first: a reviewer skimming the PR must not have to scroll to learn that the
 * automated checks this workflow relies on did not run.
 */
export function ungatedPrBlock(storyId) {
	const reasons = ungatedReasons(storyId);
	if (!reasons.length) return "";
	const bullets = reasons.map((r) => `- ${r.label}${r.detail ? ` — ${r.detail}` : ""}`).join("\n");
	return [
		"> [!WARNING]",
		"> **⚠️ Ungated delivery — this change bypassed a machine gate.**",
		">",
		...bullets.split("\n").map((l) => `> ${l}`),
		">",
		"> Cloud Mode normally replaces human review with these gates. Because one did",
		"> not apply, this diff has been reviewed by nobody and verified by nothing.",
		"> Review it manually before relying on it.",
		"",
	].join("\n");
}

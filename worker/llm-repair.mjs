// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * LLM-backed *repair* step for integrateToMain (worker side).
 *
 * A clean git rebase can still yield a tree that FAILS the deterministic
 * validation gate (compiler / linter / tests) — e.g. two independent changes
 * that each add an import land on different lines, so git merges them without a
 * conflict, producing a DUPLICATE import / identifier. The conflict resolver
 * (llm-resolver.mjs) never sees this because there were no conflict markers.
 *
 * This runs a focused pi agent session with editing tools, hands it the
 * validation error output, and lets it fix the working tree — repairing only
 * mechanical merge artifacts while preserving both changes' intent.
 * integrateToMain re-runs the validation gate after each repair (bounded), and
 * only pushes once it is green.
 *
 * Safety: the repair may only make validation pass; it does not decide to push.
 * The push is still the compare-and-swap `--ff-only` in integrateToMain, and a
 * tree that never validates is never pushed.
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Editing toolset: read + search for context, edit/write to fix the tree. No
// bash → the repair cannot run git (commit/push/checkout stay the pipeline's
// job) or other commands; integrateToMain re-validates and pushes.
const REPAIR_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

function buildPrompt(output, attempt, maxAttempts) {
	return (
		`Merging your change onto the default branch produced a tree that FAILS the\n` +
		`project's validation gate (compiler/linter/tests). This is almost always a\n` +
		`mechanical MERGE ARTIFACT from combining two independent changes — e.g. a\n` +
		`duplicate import, a duplicate identifier/declaration, or a doubled block.\n\n` +
		`Repair attempt ${attempt} of ${maxAttempts}. Fix the working tree so the\n` +
		`validation passes:\n` +
		`  - Repair ONLY merge artifacts (deduplicate imports/identifiers/\n` +
		`    declarations; reconcile a doubled block into a single correct one).\n` +
		`  - PRESERVE the intent of BOTH combined changes — never delete a feature\n` +
		`    just to silence the error.\n` +
		`  - Do NOT change unrelated code or behaviour.\n` +
		`  - Do NOT run git (no add/commit/push/checkout) — just edit files.\n\n` +
		`Edit the files directly with your tools, then stop.\n\n` +
		`----- VALIDATION OUTPUT -----\n${output}`
	);
}

/**
 * Build an LLM-backed repair function bound to a model + working directory.
 * Contract expected by integrateToMain:
 *   async ({ output, attempt, maxAttempts }) => void   (edits the tree in place)
 *
 * @param {object} opts
 * @param {import("@earendil-works/pi-coding-agent").Model<any>} opts.model
 * @param {string} opts.cwd  worktree to repair
 * @param {(e: object) => void} [opts.log]
 */
export function makeLlmRepair({ model, cwd, log = () => {}, tools = REPAIR_TOOLS }) {
	return async function repairValidation({ output, attempt = 1, maxAttempts = 3 }) {
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({ model, cwd, sessionManager, tools });
		try {
			await session.prompt(buildPrompt(output ?? "", attempt, maxAttempts));
			log({ event: "llm-repair", attempt, outcome: "attempted" });
		} finally {
			try {
				session.dispose?.();
			} catch {
				/* best effort */
			}
		}
	};
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM-backed conflict resolver for integrateToMain (worker side).
 *
 * When two agents edit overlapping lines, a deterministic union can't always
 * tell "keep both additions" from "these two changes genuinely contradict". An
 * LLM can read both sides *and the surrounding code* and produce an
 * intent-preserving merge — or declare the conflict unresolvable with a reason.
 *
 * This runs a focused pi agent session per conflicted file with READ-ONLY tools
 * (read/grep/find/ls) so it can consult the surrounding code — imports, callers,
 * type/definition sites in other files — to judge intent, but it CANNOT edit,
 * write, or run commands. It returns the resolver contract integrateToMain
 * expects:
 *   ({ file, content }) => ({ resolved } | { conflict })
 * integrateToMain (not the model) writes the merged file and `git add`s it.
 *
 * Safety: the model is instructed to output ONLY the merged file between
 * sentinels, or `UNRESOLVABLE: <reason>`. We reject any response that still
 * contains conflict markers, so a hallucinated/partial merge can never reach the
 * validation gate (let alone the push).
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

// Read-only toolset: lets the resolver consult surrounding code for context
// without any ability to mutate the tree or run commands.
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

const BEGIN = "===BEGIN_RESOLVED===";
const END = "===END_RESOLVED===";
const UNRESOLVABLE = "UNRESOLVABLE:";

function buildPrompt(file, content) {
	return (
		`You are resolving a Git merge/rebase conflict in the file \`${file}\`.\n` +
		`The file content below contains conflict markers:\n` +
		`  <<<<<<< (one side)  ======= (separator)  >>>>>>> (other side)\n` +
		`and possibly a \`||||||| \` common-ancestor section (diff3).\n\n` +
		`Produce a single, correct, fully MERGED version of the ENTIRE file that\n` +
		`PRESERVES BOTH sides' intent:\n` +
		`  - If both sides ADD different things in the same region (new registry\n` +
		`    entries, list items, imports, functions, cases), KEEP BOTH.\n` +
		`  - Respect the surrounding syntax (ordering, commas, indentation).\n` +
		`  - NEVER silently drop either side's contribution.\n` +
		`  - Only if the two changes are genuinely mutually exclusive (e.g. the same\n` +
		`    setting assigned two different values) is the conflict unresolvable.\n\n` +
		`Output format — follow EXACTLY, no prose, no code fences:\n` +
		`  • If resolvable: output the complete merged file between these lines:\n` +
		`    ${BEGIN}\n    <entire merged file>\n    ${END}\n` +
		`  • If genuinely unresolvable: output a single line:\n` +
		`    ${UNRESOLVABLE} <short explanation of the two conflicting intents>\n\n` +
		`The merged file must contain NO conflict markers.\n\n` +
		`----- FILE WITH CONFLICTS -----\n${content}`
	);
}

/** Extract concatenated text from the session's last assistant message. */
function lastAssistantText(session) {
	const messages = session.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role !== "assistant") continue;
		const c = m.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			return c
				.map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text : ""))
				.join("");
		}
	}
	return "";
}

/** Parse the model response into the resolver contract. */
export function parseResolution(text, file) {
	const t = (text ?? "").trim();
	const uIdx = t.indexOf(UNRESOLVABLE);
	const bIdx = t.indexOf(BEGIN);
	// A clear UNRESOLVABLE verdict (not preceded by a resolved block) → contradiction.
	if (uIdx !== -1 && (bIdx === -1 || uIdx < bIdx)) {
		const reason = t.slice(uIdx + UNRESOLVABLE.length).split("\n")[0].trim();
		return {
			conflict: {
				reason: "llm-unresolvable",
				message: reason || "the model judged the two changes mutually exclusive",
				file,
			},
		};
	}
	if (bIdx === -1) {
		return { conflict: { reason: "llm-no-output", message: "model did not return a resolved block", file } };
	}
	const start = bIdx + BEGIN.length;
	const eIdx = t.indexOf(END, start);
	if (eIdx === -1) {
		return { conflict: { reason: "llm-truncated", message: "resolved block was not terminated", file } };
	}
	// Preserve the file body verbatim; strip only the single newline that follows
	// BEGIN and precedes END (the sentinels are on their own lines by contract).
	let resolved = t.slice(start, eIdx);
	resolved = resolved.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
	if (resolved.includes("<<<<<<<") || resolved.includes(">>>>>>>")) {
		return { conflict: { reason: "llm-markers-remain", message: "model left conflict markers", file } };
	}
	return { resolved: `${resolved}\n` };
}

/**
 * Build an LLM-backed resolver bound to a model + working directory.
 *
 * @param {object} opts
 * @param {import("@earendil-works/pi-coding-agent").Model<any>} opts.model
 * @param {string} opts.cwd  worktree the conflicted files live in
 * @param {(e: object) => void} [opts.log]
 */
export function makeLlmResolver({ model, cwd, log = () => {}, tools = READ_ONLY_TOOLS }) {
	return async function resolveConflict({ file, content }) {
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			model,
			cwd,
			sessionManager,
			// Read-only tools only: the resolver may inspect surrounding code for
			// context but cannot write/edit/run commands. integrateToMain writes the
			// merged file and `git add`s it; parseResolution guards the output.
			tools,
		});
		try {
			await session.prompt(buildPrompt(file, content));
			const text = lastAssistantText(session);
			const result = parseResolution(text, file);
			log({ event: "llm-resolve", file, outcome: result.conflict ? result.conflict.reason : "resolved" });
			return result;
		} finally {
			try {
				session.dispose?.();
			} catch {
				/* best effort */
			}
		}
	};
}

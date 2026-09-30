// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local test event emitter — a synthetic agent with NO network / AgentCore /
 * worker involved.
 *
 * Purpose: verify the *local* live-render pipeline end to end. It writes
 * straight into the registry (status patches + streaming transcript deltas) on a
 * timer, so you can confirm the always-on widget and the `/cloud-mode` overlay
 * panel both re-render the instant an event lands — especially token-by-token
 * `thinking` deltas coalescing into one growing entry via `registry.appendDelta`.
 *
 * This is the isolation test for "can I see live updates?" before wiring a real
 * Strands/AgentCore worker: same render path, deterministic fake events.
 */

import type { AgentRegistry, AgentStatus, TranscriptEntry } from "./registry.ts";

interface EmitterDeps {
	registry: AgentRegistry;
	sessionId: string;
	signal: AbortSignal;
	/** Called after status changes so the extension can refresh its status line. */
	onChange?: () => void;
}

/** One scripted step: either a status change or a streamed transcript delta. */
type Step =
	| { kind: "status"; status: AgentStatus }
	| { kind: "line"; entryKind: TranscriptEntry["kind"]; text: string }
	| { kind: "stream"; entryKind: TranscriptEntry["kind"]; text: string };

/** Resolve after `ms`, or immediately when aborted. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Stream a string into one coalesced transcript entry, word by word. */
async function streamEntry(
	deps: EmitterDeps,
	entryKind: TranscriptEntry["kind"],
	text: string,
): Promise<void> {
	const { registry, sessionId, signal } = deps;
	const words = text.split(" ");
	for (let i = 0; i < words.length; i++) {
		if (signal.aborted) return;
		registry.appendDelta(sessionId, entryKind, (i === 0 ? "" : " ") + words[i]);
		await sleep(90, signal);
	}
}

/**
 * The scripted scenario. Mirrors the shape of a real run (user prompt →
 * thinking → tool call → tool result → thinking → answer → done) so the render
 * output looks like the real thing.
 */
const SCRIPT: Step[] = [
	{ kind: "status", status: "running" },
	{ kind: "line", entryKind: "user", text: "Add a health-check endpoint to the server." },
	{
		kind: "stream",
		entryKind: "thinking",
		text: "Let me look at how the server is structured. I should find the request handler, add a GET /healthz route that returns 200, and keep it dependency-free.",
	},
	{ kind: "line", entryKind: "tool", text: "⚙ read(path=server.mjs)" },
	{ kind: "line", entryKind: "toolResult", text: "↳ read\nconst server = createServer((req, res) => { … })" },
	{
		kind: "stream",
		entryKind: "thinking",
		text: "Good — there is a single createServer handler. I will branch on req.url === '/healthz' before the 404 fallback and return a small JSON body.",
	},
	{ kind: "line", entryKind: "tool", text: "⚙ edit(path=server.mjs)" },
	{ kind: "line", entryKind: "toolResult", text: "↳ edit\nSuccessfully added /healthz route." },
	{ kind: "stream", entryKind: "assistant", text: "Done — added a GET /healthz endpoint returning {\"status\":\"ok\"}." },
	{ kind: "status", status: "done" },
];

/**
 * Run the scripted synthetic agent to completion (or until aborted).
 * The agent must already be registered under `sessionId`.
 */
export async function runTestEmitter(deps: EmitterDeps): Promise<void> {
	const { registry, sessionId, signal, onChange } = deps;
	for (const step of SCRIPT) {
		if (signal.aborted) return;
		if (step.kind === "status") {
			registry.patch(sessionId, { status: step.status });
			onChange?.();
		} else if (step.kind === "line") {
			registry.appendTranscript(sessionId, { kind: step.entryKind, text: step.text });
		} else {
			await streamEntry(deps, step.entryKind, step.text);
		}
		await sleep(500, signal);
	}
}

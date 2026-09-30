// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory registry of delegated cloud agents.
 *
 * New model — "live overlay, never switch sessions": an agent no longer owns a
 * pi session file. Instead each agent keeps an in-memory transcript buffer that
 * the SSE stream appends to, and the registry is a tiny pub/sub so the live
 * dashboard widget + overlay panel re-render the instant an event arrives. Your
 * own local pi session is never touched, so "go back to pi" is just closing the
 * overlay (esc), and updates are truly live (no manual refresh, no re-read).
 */

import { sanitizeEventText } from "./transcript.ts";

export type AgentStatus =
	| "starting"
	| "authenticating"
	| "cloning"
	| "running"
	| "pushing"
	/**
	 * The *viewer's* stream to AgentCore dropped while the worker was still
	 * working. Not a failure: the worker keeps running server-side and we resume
	 * by polling the read-only `attach` action. Non-terminal on purpose.
	 */
	| "reconnecting"
	| "done"
	| "failed";

/** One rendered line group in an agent's transcript. */
export interface TranscriptEntry {
	kind: "user" | "assistant" | "thinking" | "tool" | "toolResult" | "status" | "pr" | "error" | "note";
	/** Display text (may contain newlines; the panel wraps it). */
	text: string;
	timestamp: number;
}

export interface CloudAgent {
	/** AgentCore runtime-session-id (>= 33 chars). */
	sessionId: string;
	/** Short story id/slug. */
	storyId: string;
	/** Headline shown in the picker / dashboard. */
	headline: string;
	/** Full story text. */
	description: string;
	status: AgentStatus;
	prUrl?: string;
	/** direct-merge: SHA of the commit landed on the default branch. */
	commitSha?: string;
	/** direct-merge: link to the commit on the default branch. */
	commitUrl?: string;
	/** How this story was delivered (defaults to pull-request when unset). */
	deliveryMode?: "pull-request" | "direct-merge";
	branch?: string;
	errorMessage?: string;
	startedAt: number;
	/** Live, in-memory transcript rendered from the agent's event stream. */
	transcript: TranscriptEntry[];
	/**
	 * Highest event `seq` rendered from the worker so far. Drives gap-free,
	 * duplicate-free resume when a stream drops and we re-attach via polling, and
	 * client-side dedup so a replay never double-appends the transcript.
	 */
	lastSeq?: number;
}

const TERMINAL: AgentStatus[] = ["done", "failed"];

export class AgentRegistry {
	private agents = new Map<string, CloudAgent>();
	private listeners = new Set<() => void>();

	/** Subscribe to any registry change (add / patch / transcript append). */
	subscribe(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(): void {
		for (const cb of this.listeners) {
			try {
				cb();
			} catch {
				/* a stale subscriber must never break the stream loop */
			}
		}
	}

	add(agent: CloudAgent): void {
		this.agents.set(agent.sessionId, agent);
		this.emit();
	}

	get(sessionId: string): CloudAgent | undefined {
		return this.agents.get(sessionId);
	}

	hasStory(storyId: string): boolean {
		for (const a of this.agents.values()) if (a.storyId === storyId) return true;
		return false;
	}

	list(): CloudAgent[] {
		return [...this.agents.values()].sort((a, b) => a.startedAt - b.startedAt);
	}

	indexOf(sessionId: string): number {
		return this.list().findIndex((a) => a.sessionId === sessionId);
	}

	activeCount(): number {
		return this.list().filter((a) => !TERMINAL.includes(a.status)).length;
	}

	isTerminal(status: AgentStatus): boolean {
		return TERMINAL.includes(status);
	}

	patch(sessionId: string, patch: Partial<CloudAgent>): CloudAgent | undefined {
		const a = this.agents.get(sessionId);
		if (!a) return undefined;
		Object.assign(a, patch);
		this.emit();
		return a;
	}

	appendTranscript(sessionId: string, entry: Omit<TranscriptEntry, "timestamp">): void {
		const a = this.agents.get(sessionId);
		if (!a) return;
		// Single sanitisation chokepoint for operator-visible text (T-026 / M-036):
		// every caller — rendered messages, status lines, errors — lands here.
		a.transcript.push({ ...entry, text: sanitizeEventText(entry.text), timestamp: Date.now() });
		this.emit();
	}

	/**
	 * Append a streaming *delta* of the given kind. If the last transcript entry
	 * is already the same kind, the chunk is concatenated onto it (so a stream of
	 * thinking/text tokens grows one entry live); otherwise a new entry starts.
	 * This is the coalescing primitive for incremental (delta) event rendering —
	 * e.g. token-by-token reasoning — as opposed to finalized `message_end`
	 * messages, which use `appendTranscript`.
	 */
	appendDelta(sessionId: string, kind: TranscriptEntry["kind"], chunk: string): void {
		const a = this.agents.get(sessionId);
		if (!a) return;
		// Deltas are sanitised per chunk. A sequence split across two chunks cannot
		// reassemble into a live one because the lone ESC is stripped on arrival
		// (T-026 / M-036).
		const text = sanitizeEventText(chunk);
		if (!text) return;
		const last = a.transcript[a.transcript.length - 1];
		if (last && last.kind === kind) {
			last.text += text;
			last.timestamp = Date.now();
		} else {
			a.transcript.push({ kind, text, timestamp: Date.now() });
		}
		this.emit();
	}

	/** Remove a single agent by session id. Returns true if one was removed. */
	remove(sessionId: string): boolean {
		const existed = this.agents.delete(sessionId);
		if (existed) this.emit();
		return existed;
	}

	/**
	 * Remove finished (done/failed) agents from the registry. Returns the removed
	 * session ids. Running agents are left untouched.
	 */
	clearTerminal(): string[] {
		const removed: string[] = [];
		for (const [id, a] of this.agents) {
			if (TERMINAL.includes(a.status)) {
				this.agents.delete(id);
				removed.push(id);
			}
		}
		if (removed.length > 0) this.emit();
		return removed;
	}
}

/** A statusable glyph for list rendering. */
export function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "done":
			return "✓";
		case "failed":
			return "✗";
		case "running":
			return "●";
		case "pushing":
			return "▲";
		case "reconnecting":
			return "↻";
		default:
			return "◌";
	}
}

/** Human label for a status. */
export function statusLabel(status: AgentStatus): string {
	return status;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent stream consumer — live in-memory transcript rendering.
 *
 * Consumes the AgentCore SSE stream for one runtime session and appends
 * rendered entries into the agent's in-memory transcript buffer (registry).
 * Every append notifies the registry's subscribers, so the dashboard widget and
 * the overlay panel re-render live — no session file, no session switch, and no
 * manual refresh. Your local pi session is never touched.
 *
 * Watching is resilient: every worker event carries a monotonic `seq`, so if a
 * stream drops without a terminal event we transparently resume by polling the
 * worker's read-only `attach` action from the last seq rendered. A client-side
 * seq guard drops any replayed event we've already rendered (gap-free,
 * duplicate-free).
 */

import { invokeAgentRuntime } from "./agentcore.ts";
import type { CloudModeConfig } from "./config.ts";
import { withOwnerToken } from "./identity.ts";
import type { AgentRegistry, AgentStatus, TranscriptEntry } from "./registry.ts";
import { renderMessage } from "./transcript.ts";

interface AgentMessageLike {
	role: string;
	content: unknown;
	[k: string]: unknown;
}

interface StreamEvent {
	type?: string;
	message?: AgentMessageLike;
	status?: string;
	url?: string;
	branch?: string;
	exitCode?: number;
	/** direct-merge result: commit SHA landed on the default branch. */
	commitSha?: string;
	/** direct-merge result: link to the commit on the default branch. */
	commitUrl?: string;
	/** pull-request delivery: the PR that was landed. */
	prUrl?: string;
	/** cloud_pr: whether GitHub auto-merge was armed on the PR. */
	autoMerge?: boolean;
	/** cloud_status: extra human-readable context (e.g. why a merge is blocked). */
	detail?: unknown;
	/** cloud_integrate: which step of integrateToMain() this event reports. */
	event?: string;
	/** cloud_integrate: 1-based attempt number in the rebase/validate/push loop. */
	attempt?: number;
	/** cloud_integrate (conflict): unmerged paths reported by the rebase. */
	files?: string[];
	/** cloud_integrate (llm-resolve): the file the resolver was asked to merge. */
	file?: string;
	/** cloud_integrate (llm-resolve / llm-repair): resolver verdict. */
	outcome?: string;
	/** cloud_integrate (validation / repair-validation): did the gate pass? */
	ok?: boolean;
	/** cloud_integrate (repair-attempt / repair-validation): repair round. */
	repair?: number;
	/** cloud_integrate (push-rejected): jittered wait before the next attempt. */
	backoffMs?: number;
	/** cloud_integrate (push-rejected / *-error): machine reason string. */
	reason?: string;
	/** cloud_integrate (exhausted / summary): attempts consumed. */
	attemptsUsed?: number;
	/** cloud_integrate (summary): total integration wall time. */
	wallMs?: number;
	/** Monotonic per-session sequence number stamped by the worker Hub. */
	seq?: number;
	/** On a read-only `attach`: the session is no longer live; stop polling. */
	fatal?: boolean;
}

export interface ConsumeDeps {
	config: CloudModeConfig;
	sessionId: string;
	payload: Record<string, unknown>;
	registry: AgentRegistry;
	signal?: AbortSignal;
	/** Called after any registry status change (for the status line). */
	onChange?: () => void;
	/** Surface transient issues without throwing. */
	onError?: (message: string) => void;
}

const STATUS_MAP: Record<string, AgentStatus> = {
	authenticating: "authenticating",
	cloning: "cloning",
	agent_running: "running",
	pushing: "pushing",
	no_changes: "running",
	// PR delivery: CI gate + landing happen while the session is still alive.
	ci_waiting: "pushing",
	ci_fixing: "running",
	ci_passed: "pushing",
	merging: "pushing",
	rebased_on_base: "pushing",
};

/** Poll interval (ms) for the read-only re-attach loop once a stream drops. */
const POLL_INTERVAL_MS = 3000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Stream a single invoke to completion, rendering into the agent's transcript.
 * Resolves when the stream closes (agent finished, errored, or aborted).
 *
 * If the stream ends *without* a terminal event while the agent is still
 * non-terminal (a transient drop / idle reset), we transparently resume by
 * polling the worker's read-only `attach` action with the last seq we rendered.
 */
export async function consumeStream(deps: ConsumeDeps): Promise<void> {
	const { config, sessionId, payload, registry, signal, onChange, onError } = deps;
	try {
		for await (const raw of invokeAgentRuntime({
			region: config.region,
			agentRuntimeArn: config.agentRuntimeArn,
			qualifier: config.qualifier,
			sessionId,
			// Every action carries the session's owner token, so the worker can tell
			// the delegating client apart from anyone else who learned the session id
			// (threat model T-002 / M-020).
			payload: withOwnerToken(sessionId, payload),
			signal,
		})) {
			handleEvent(raw as StreamEvent, { registry, sessionId, onChange });
		}
	} catch (err) {
		if ((err as Error)?.name === "AbortError") return;
		const message = (err as Error)?.message ?? String(err);
		const action = String(payload.action ?? "start");
		const cur = registry.get(sessionId);
		// A throwing stream is almost never a dead agent — it is our own SSE
		// connection being torn down ("aborted", idle reset, network blip) while the
		// worker keeps going server-side on its own AgentCore session. Only the
		// worker may declare failure (`cloud_error` / non-zero `cloud_done`), so as
		// long as the agent is non-terminal we say "reconnecting" and fall through
		// to the same polling recovery the clean-exit path uses.
		const recoverable =
			(action === "start" || action === "attach") && cur && !registry.isTerminal(cur.status);
		if (!recoverable) {
			registry.patch(sessionId, { status: "failed", errorMessage: message });
			registry.appendTranscript(sessionId, { kind: "error", text: `⚠️ Stream error: ${message}` });
			onChange?.();
			onError?.(message);
			return;
		}
		registry.patch(sessionId, { status: "reconnecting", errorMessage: undefined });
		registry.appendTranscript(sessionId, {
			kind: "note",
			text: `↻ Stream dropped (${message}) — the agent keeps running; reattaching…`,
		});
		onChange?.();
		onError?.(message);
		await pollUntilTerminal(deps);
		return;
	}

	// Stream ended cleanly. If the agent is still non-terminal, it was a drop
	// (not a real finish) — resume by polling the read-only `attach` action.
	// Only the resilient watch streams (`start` / `attach`) own this loop.
	const action = String(payload.action ?? "start");
	if (action === "start" || action === "attach") {
		await pollUntilTerminal(deps);
	}
}

/**
 * Poll the worker's read-only `attach` action until the agent reaches a terminal
 * state (or we're aborted). Each poll replays only events after our `lastSeq`.
 *
 * A poll that itself throws is *not* fatal — the worker may simply be between
 * responses. We keep the agent non-terminal and try again on the next tick; only
 * a `fatal` `cloud_error` from the worker ("session is no longer live") ends the
 * loop with a failure.
 */
async function pollUntilTerminal(deps: ConsumeDeps): Promise<void> {
	const { config, sessionId, registry, signal, onChange, onError } = deps;
	while (true) {
		if (signal?.aborted) return;
		const cur = registry.get(sessionId);
		if (!cur || registry.isTerminal(cur.status)) return;

		await sleep(POLL_INTERVAL_MS, signal);
		if (signal?.aborted) return;
		const sinceSeq = registry.get(sessionId)?.lastSeq ?? 0;

		try {
			for await (const raw of invokeAgentRuntime({
				region: config.region,
				agentRuntimeArn: config.agentRuntimeArn,
				qualifier: config.qualifier,
				sessionId,
				payload: withOwnerToken(sessionId, { action: "attach", sinceSeq }),
				signal,
			})) {
				const ev = raw as StreamEvent;
				if (ev.type === "cloud_error" && ev.fatal) {
					const message = String((ev as { message?: string }).message ?? "Session is no longer live");
					registry.patch(sessionId, { status: "failed", errorMessage: message });
					registry.appendTranscript(sessionId, { kind: "error", text: `⚠️ ${message}` });
					onChange?.();
					return;
				}
				// First event after a drop proves the worker is alive again: leave the
				// "reconnecting" placeholder unless the event itself carries a status.
				if (registry.get(sessionId)?.status === "reconnecting" && ev.type !== "cloud_status") {
					registry.patch(sessionId, { status: "running" });
					onChange?.();
				}
				handleEvent(ev, { registry, sessionId, onChange });
			}
		} catch (err) {
			if ((err as Error)?.name === "AbortError") return;
			onError?.((err as Error)?.message ?? String(err));
		}
	}
}

/**
 * Render one `cloud_integrate` event — the audit trail of `integrateToMain()`
 * in the worker (fetch → rebase → resolve → validate → compare-and-swap push).
 *
 * These events are the only externally visible evidence that the decentralized
 * landing loop did anything: a lost CAS (`push-rejected`) is a *timing* failure
 * that the retry loop hides, while a `conflict` is a *content* failure that only
 * the LLM resolver can settle. Without rendering them both outcomes look
 * identical to "the agent just pushed", so they are surfaced verbatim.
 *
 * Returns `undefined` for bookkeeping events that would only add noise.
 */
function renderIntegrateEvent(ev: StreamEvent): Omit<TranscriptEntry, "timestamp"> | undefined {
	const branch = ev.branch ?? "the default branch";
	const at = ev.attempt ? ` (attempt ${ev.attempt})` : "";
	const detail = (): string => {
		const d = ev.detail;
		if (d == null) return ev.reason ?? "unknown reason";
		if (typeof d === "string") return d;
		const m = (d as { message?: unknown; reason?: unknown }).message ?? (d as { reason?: unknown }).reason;
		return typeof m === "string" ? m : JSON.stringify(d);
	};

	switch (ev.event) {
		case "fetched":
			return { kind: "note", text: `↻ Re-read ${branch}${at} before landing.` };
		case "conflict":
			return {
				kind: "status",
				text: `⚡ Content conflict${at} in ${(ev.files ?? []).join(", ") || "the rebase"} — resolving.`,
			};
		case "llm-resolve":
			return ev.outcome === "resolved"
				? { kind: "status", text: `🧠 LLM resolver merged ${ev.file}, preserving both intents.` }
				: { kind: "error", text: `⛔ LLM resolver refused ${ev.file}: ${ev.outcome}` };
		case "unresolvable":
			return { kind: "error", text: `⛔ Unresolvable conflict${at}: ${detail()}` };
		case "rebase-error":
			return { kind: "error", text: `⚠️ Rebase failed${at}: ${ev.reason ?? "unknown reason"}` };
		case "validation":
			return {
				kind: ev.ok ? "note" : "status",
				text: ev.ok
					? `✓ Validation gate passed${at} on the merged tree.`
					: `✗ Validation gate failed${at} on the merged tree.`,
			};
		case "repair-attempt":
			return { kind: "status", text: `🔧 Repairing the merged tree (repair ${ev.repair ?? 1}).` };
		case "repair-validation":
			return {
				kind: ev.ok ? "note" : "status",
				text: `${ev.ok ? "✓" : "✗"} Re-validation after repair ${ev.repair ?? 1}.`,
			};
		case "repair-error":
			return { kind: "error", text: `⚠️ Repair ${ev.repair ?? 1} errored: ${ev.reason ?? "unknown reason"}` };
		case "push-rejected":
			return {
				kind: "status",
				text:
					`⇄ Lost the compare-and-swap on ${branch}${at} — another agent landed first; ` +
					`retrying in ${ev.backoffMs ?? 0}ms.`,
			};
		case "push-error":
			return { kind: "error", text: `⚠️ Push failed${at}: ${ev.reason ?? "unknown reason"}` };
		case "push-success":
			return {
				kind: "note",
				text: `⬆ Fast-forward push to ${branch} succeeded${at}.`,
			};
		case "exhausted":
			return {
				kind: "error",
				text: `⛔ Gave up after ${ev.attemptsUsed ?? "?"} attempts — ${branch} kept moving.`,
			};
		default:
			// repair-committed / summary / llm-repair and any future bookkeeping event:
			// intentionally silent so the transcript stays readable.
			return undefined;
	}
}

function handleEvent(
	ev: StreamEvent,
	ctx: { registry: AgentRegistry; sessionId: string; onChange?: () => void },
): void {
	const { registry, sessionId, onChange } = ctx;
	// Client-side seq guard: skip anything we've already rendered so a replay
	// (re-attach / poll overlap) never double-appends the transcript.
	if (typeof ev.seq === "number") {
		const cur = registry.get(sessionId);
		if (cur && (cur.lastSeq ?? 0) >= ev.seq) return;
		if (cur) registry.patch(sessionId, { lastSeq: ev.seq });
	}
	switch (ev.type) {
		case "message_end": {
			if (ev.message && typeof ev.message.role === "string") {
				for (const entry of renderMessage(ev.message)) registry.appendTranscript(sessionId, entry);
			}
			return;
		}
		case "cloud_status": {
			const mapped = ev.status ? STATUS_MAP[ev.status] : undefined;
			if (mapped) {
				registry.patch(sessionId, { status: mapped });
				onChange?.();
			}
			if (ev.status === "no_changes") {
				registry.appendTranscript(sessionId, {
					kind: "note",
					text: "ℹ️ Agent produced no changes; nothing delivered.",
				});
			}
			if (ev.status === "merge_blocked") {
				registry.appendTranscript(sessionId, {
					kind: "error",
					text: `⚠️ Pull request could not be landed: ${String((ev as { detail?: string }).detail ?? "unknown reason")}`,
				});
			}
			if (ev.status === "auto_merge_unavailable") {
				registry.appendTranscript(sessionId, {
					kind: "note",
					text: "ℹ️ GitHub auto-merge could not be armed; the pipeline will merge explicitly once CI is green.",
				});
			}
			if (ev.status === "rebased_on_base") {
				registry.appendTranscript(sessionId, {
					kind: "note",
					text: "ℹ️ Another change landed first; the PR was updated onto the new base and CI re-runs.",
				});
			}
			return;
		}
		case "cloud_integrate": {
			const rendered = renderIntegrateEvent(ev);
			if (rendered) {
				registry.appendTranscript(sessionId, rendered);
				onChange?.();
			}
			return;
		}
		case "cloud_pr": {
			registry.patch(sessionId, { prUrl: ev.url, branch: ev.branch });
			const armed = (ev as { autoMerge?: boolean }).autoMerge === true;
			registry.appendTranscript(sessionId, {
				kind: "pr",
				text: `✅ Pull request opened${armed ? " (auto-merge armed)" : ""}: ${ev.url}`,
			});
			onChange?.();
			return;
		}
		case "cloud_merge": {
			// direct-merge carries a commit SHA; PR delivery reports the landed PR.
			if (ev.commitSha || ev.commitUrl) {
				const link = ev.commitUrl ?? ev.commitSha ?? "";
				registry.patch(sessionId, {
					commitSha: ev.commitSha,
					commitUrl: ev.commitUrl,
					branch: ev.branch,
					deliveryMode: "direct-merge",
				});
				registry.appendTranscript(sessionId, {
					kind: "pr",
					text: `✅ Merged directly to ${ev.branch}: ${link}`,
				});
			} else {
				const prUrl = (ev as { prUrl?: string }).prUrl ?? registry.get(sessionId)?.prUrl ?? "";
				registry.patch(sessionId, { deliveryMode: "pull-request", prUrl: prUrl || undefined });
				registry.appendTranscript(sessionId, {
					kind: "pr",
					text: `✅ Pull request merged into ${ev.branch}${prUrl ? `: ${prUrl}` : ""}`,
				});
			}
			onChange?.();
			return;
		}
		case "cloud_error": {
			const message = String((ev as { message?: string }).message ?? "unknown error");
			registry.patch(sessionId, { status: "failed", errorMessage: message });
			registry.appendTranscript(sessionId, { kind: "error", text: `⚠️ ${message}` });
			onChange?.();
			return;
		}
		case "cloud_done": {
			const cur = registry.get(sessionId);
			if (cur && !registry.isTerminal(cur.status)) {
				registry.patch(sessionId, { status: ev.exitCode === 0 ? "done" : "failed" });
			}
			onChange?.();
			return;
		}
		default:
			return;
	}
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrator ↔ agent IPC.
 *
 * See `docs/agent-isolation.md`. The agent runs in its own process as the
 * unprivileged user; this module is the *entire* vocabulary the two processes
 * share. Its narrowness is the control: there is deliberately no message for
 * "give me a secret", "run a git command", "open a pull request" or "merge" —
 * delivery stays in the orchestrator, so the system prompt's "do not use git"
 * (defence in depth only) becomes structural.
 *
 * Framing is newline-delimited JSON over the child's stdin/stdout:
 *   - no socket to bind, no port to guess, no ambient namespace — being the
 *     parent process is the only way to talk to the agent;
 *   - a line cap bounds host memory against a hostile or runaway payload (same
 *     reasoning as the bounded event history);
 *   - malformed lines are dropped with a warning rather than crashing a run that
 *     may already have produced work.
 */

/** Child → host message types. */
export const CHILD_MESSAGES = ["ready", "event", "turn_done", "fatal", "log"];
/** Host → child message types. */
export const HOST_MESSAGES = ["init", "prompt", "interrupt", "shutdown"];

/** Max bytes for one IPC line before it is refused (not truncated silently). */
export const MAX_LINE_BYTES = Number(process.env.CLOUD_MODE_IPC_MAX_LINE ?? 4 * 1024 * 1024);

/** Serialise one message to a single line. Throws when it would exceed the cap. */
export function encodeMessage(message) {
	const line = JSON.stringify(message);
	if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
		throw new Error(`IPC message of type '${message?.type}' exceeds ${MAX_LINE_BYTES} bytes`);
	}
	return `${line}\n`;
}

/**
 * Build a line-oriented decoder.
 *
 * @param {(msg: object) => void} onMessage
 * @param {(problem: string) => void} [onProblem]
 */
export function createLineDecoder(onMessage, onProblem = () => {}) {
	let buffer = "";
	let overflowed = false;
	return function feed(chunk) {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl < 0) break;
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (overflowed) {
				// We were mid-overflow: this line is the tail of a refused message.
				overflowed = false;
				onProblem("dropped the remainder of an oversized IPC line");
				continue;
			}
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
					onProblem(`ignored IPC line without a type: ${line.slice(0, 120)}`);
					continue;
				}
				onMessage(parsed);
			} catch {
				onProblem(`ignored unparseable IPC line: ${line.slice(0, 120)}`);
			}
		}
		if (Buffer.byteLength(buffer, "utf8") > MAX_LINE_BYTES) {
			// Refuse rather than grow: an unbounded buffer is a host-memory DoS.
			buffer = "";
			overflowed = true;
			onProblem(`refused an IPC line larger than ${MAX_LINE_BYTES} bytes`);
		}
	};
}

/**
 * Validate a message against the direction it arrived from. Unknown types are
 * reported, not thrown: forward compatibility must not break a live run.
 *
 * @param {object} message
 * @param {"child"|"host"} from
 */
export function isExpected(message, from) {
	const allowed = from === "child" ? CHILD_MESSAGES : HOST_MESSAGES;
	return allowed.includes(message?.type);
}

/**
 * Extract the fields of an `init` message, dropping anything not in the
 * contract. The child is unprivileged but the *host* is the thing worth
 * protecting from surprises, so both directions are narrowed explicitly.
 */
export function sanitizeInit(init = {}) {
	const { cwd, model, provider, systemPrompt, proxy, sandbox } = init;
	return {
		cwd: String(cwd ?? ""),
		model: String(model ?? ""),
		provider: String(provider ?? ""),
		systemPrompt: typeof systemPrompt === "string" ? systemPrompt : undefined,
		proxy: proxy ? { url: String(proxy.url ?? ""), token: String(proxy.token ?? "") } : undefined,
		sandbox: sandbox ? { mode: String(sandbox.mode ?? "") } : undefined,
	};
}

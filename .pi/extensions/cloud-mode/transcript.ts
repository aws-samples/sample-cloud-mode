// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Message → transcript renderer.
 *
 * The worker streams raw pi `AgentSession` events over SSE. Since the new
 * design renders agents in a custom overlay (not by replaying into a pi session
 * file), we translate each finalized `message_end` message into compact,
 * human-readable transcript entries the panel can display and live-update.
 */

import type { TranscriptEntry } from "./registry.ts";

/**
 * ANSI / terminal control sequences an agent must never be able to emit into the
 * operator's terminal (threat model T-026 / M-036).
 *
 * Everything rendered in the overlay originates from untrusted text: repository
 * contents, story text, CI logs and model output. A raw escape sequence in any
 * of those can retitle the window (`OSC 0`), clear the screen (`CSI 2J`), move
 * the cursor over pi's own UI chrome, or hide a line the operator should have
 * seen while deciding whether a delivery is trustworthy.
 *
 * The policy is deliberately blunt: strip, do not escape, and drop colour with
 * everything else. Nothing in the stream has a legitimate need to control the
 * terminal — the panel does its own styling — so an allow-list of "harmless"
 * sequences would only be an attack surface. `\n` and `\t` survive because the
 * panel wraps and indents on them.
 *
 * Sanitisation happens at *ingest* (see `registry.appendTranscript`), not at
 * render time, so every present and future consumer of a transcript entry is
 * safe by construction. The durable record is unaffected: the worker archives
 * raw bytes to S3 (M-025), which is what forensics needs.
 */
const CONTROL_SEQUENCES = [
	// CSI … final byte — cursor movement, erase, SGR colour, private modes.
	/\u001b\[[0-?]*[ -/]*[@-~]/g,
	// OSC … terminator (BEL or ST) — window title, hyperlinks, clipboard writes.
	/\u001b\][\s\S]*?(?:\u0007|\u001b\\|\u009c)/g,
	// DCS / SOS / PM / APC … ST — sixel, device control, application commands.
	/\u001b[PX^_][\s\S]*?(?:\u001b\\|\u009c)/g,
	// 8-bit CSI/OSC introducers (C1 forms of the two above).
	/\u009b[0-?]*[ -/]*[@-~]/g,
	/\u009d[\s\S]*?(?:\u0007|\u009c)/g,
	// Two-character escapes: charset selection, SS2/SS3, RIS (\u001bc) etc.
	// Intermediates deliberately exclude SP (0x20): a lone ESC followed by a space
	// must not swallow the next word, and the trailing lone-ESC rule below makes
	// that case inert anyway.
	/\u001b[!-/]*[0-~]/g,
	// Any remaining lone ESC.
	/\u001b/g,
];

/** C0 controls except \n and \t, plus DEL and the C1 block. */
const BARE_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f-\u009f]/g;

/**
 * Make one untrusted string inert for terminal rendering.
 *
 * Idempotent (running it twice changes nothing) and non-truncating: the text
 * stays readable, it just cannot act. Non-strings pass through as "" so a
 * malformed event cannot smuggle an object into the renderer.
 */
export function sanitizeEventText(value: unknown): string {
	if (typeof value !== "string") return "";
	if (value === "") return "";
	let out = value;
	for (const re of CONTROL_SEQUENCES) out = out.replace(re, "");
	// \r on its own is a cursor move (overwrite-the-line trick); \r\n was already
	// normalised to \n by the split above only if paired, so handle both here.
	out = out.replace(/\r\n?/g, "\n");
	return out.replace(BARE_CONTROL_CHARS, "");
}

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
interface ToolCallBlock {
	type: "toolCall";
	name: string;
	arguments?: Record<string, unknown>;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock | { type: string; [k: string]: unknown };

interface AgentMessageLike {
	role: string;
	content: unknown;
	toolName?: string;
	isError?: boolean;
	[k: string]: unknown;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlock[]) {
		if (block && typeof block === "object") {
			if (block.type === "text" && typeof (block as TextBlock).text === "string") {
				parts.push((block as TextBlock).text);
			}
		}
	}
	return parts.join("\n").trim();
}

function summarizeArgs(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	const keys = Object.keys(args);
	// Favor the arguments developers care about first.
	const pref = ["path", "file", "command", "pattern", "storyId", "query"];
	const ordered = [...pref.filter((k) => k in args), ...keys.filter((k) => !pref.includes(k))];
	const shown: string[] = [];
	for (const k of ordered.slice(0, 3)) {
		let v = args[k];
		if (typeof v !== "string") v = JSON.stringify(v);
		let s = String(v).replace(/\s+/g, " ").trim();
		if (s.length > 60) s = `${s.slice(0, 59)}…`;
		shown.push(`${k}=${s}`);
	}
	return shown.join(" ");
}

/**
 * Convert one finalized message into zero or more transcript entries.
 * Assistant messages fan out into thinking / text / per-tool-call entries so the
 * panel can style each independently.
 */
export function renderMessage(message: AgentMessageLike): Array<Omit<TranscriptEntry, "timestamp">> {
	const out: Array<Omit<TranscriptEntry, "timestamp">> = [];
	const role = message.role;

	if (role === "user") {
		const text = textOf(message.content);
		if (text) out.push({ kind: "user", text });
		return out;
	}

	if (role === "toolResult") {
		const text = textOf(message.content);
		const name = typeof message.toolName === "string" ? message.toolName : "tool";
		const prefix = message.isError ? `✗ ${name} error` : `↳ ${name}`;
		const body = text.length > 400 ? `${text.slice(0, 399)}…` : text;
		out.push({ kind: "toolResult", text: body ? `${prefix}\n${body}` : prefix });
		return out;
	}

	if (role === "assistant") {
		if (!Array.isArray(message.content)) {
			const text = textOf(message.content);
			if (text) out.push({ kind: "assistant", text });
			return out;
		}
		for (const block of message.content as ContentBlock[]) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "thinking") {
				const t = (block as ThinkingBlock).thinking?.trim();
				if (t) out.push({ kind: "thinking", text: t });
			} else if (block.type === "text") {
				const t = (block as TextBlock).text?.trim();
				if (t) out.push({ kind: "assistant", text: t });
			} else if (block.type === "toolCall") {
				const tc = block as ToolCallBlock;
				const args = summarizeArgs(tc.arguments);
				out.push({ kind: "tool", text: args ? `⚙ ${tc.name}(${args})` : `⚙ ${tc.name}` });
			}
		}
		return out;
	}

	// Unknown/custom role: best-effort text.
	const text = textOf(message.content);
	if (text) out.push({ kind: "note", text });
	return out;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Invariant tests for the overlay output sanitiser.
 *
 * Everything rendered in the local overlay comes from untrusted text: repository
 * contents, story text, CI logs and model output. This suite asserts that a
 * hostile payload cannot reach the renderer with its terminal control sequences
 * intact — and, like the SAST gate test, it is written so that removing or
 * bypassing the sanitiser makes it fail rather than silently pass.
 *
 * Two layers are covered:
 *   1. `sanitizeEventText()` itself (the policy).
 *   2. The registry ingest chokepoint — `appendTranscript` / `appendDelta` —
 *      because that is where every producer in the extension actually lands.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeEventText } from "../.pi/extensions/cloud-mode/transcript.ts";
import { AgentRegistry } from "../.pi/extensions/cloud-mode/registry.ts";

const ESC = "\u001b";

/** Payloads a malicious repo/CI/model could put into a stream. */
const HOSTILE = [
	["erase display", `${ESC}[2J`],
	["cursor home", `${ESC}[1;1H`],
	["cursor up over pi's chrome", `${ESC}[10A`],
	["SGR colour", `${ESC}[31;1mred${ESC}[0m`],
	["window title (OSC + BEL)", `${ESC}]0;pwned\u0007`],
	["window title (OSC + ST)", `${ESC}]0;pwned${ESC}\\`],
	["OSC 8 hyperlink", `${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`],
	["DCS payload", `${ESC}Pq#0;2;0;0;0${ESC}\\`],
	["APC payload", `${ESC}_Gf=100${ESC}\\`],
	["private mode (hide cursor)", `${ESC}[?25l`],
	["RIS terminal reset", `${ESC}c`],
	["charset switch", `${ESC}(0`],
	["SS3 key", `${ESC}OP`],
	["8-bit CSI", "\u009b2J"],
	["8-bit OSC", "\u009d0;pwned\u0007"],
	["lone ESC", ESC],
	["bare BEL", "\u0007"],
	["carriage-return overwrite", "safe\rHACKED"],
	["backspace rubout", "safe\u0008\u0008\u0008\u0008evil"],
	["C1 block", "\u0085\u008f\u009f"],
	["DEL", "\u007f"],
];

test("sanitizeEventText strips every hostile control sequence", () => {
	for (const [label, payload] of HOSTILE) {
		const out = sanitizeEventText(`before ${payload} after`);
		assert.ok(!out.includes(ESC), `${label}: ESC survived -> ${JSON.stringify(out)}`);
		assert.ok(!out.includes("\u0007"), `${label}: BEL survived -> ${JSON.stringify(out)}`);
		assert.ok(!out.includes("\r"), `${label}: CR survived -> ${JSON.stringify(out)}`);
		assert.ok(
			!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(out),
			`${label}: control char survived -> ${JSON.stringify(out)}`,
		);
		// Non-truncating: the readable words around the payload stay.
		assert.ok(out.includes("before"), `${label}: leading text lost`);
		assert.ok(out.includes("after"), `${label}: trailing text lost`);
	}
});

test("sanitizeEventText preserves newlines, tabs and ordinary unicode", () => {
	const text = "line1\nline2\tcolumn\n  indented\n🚀 émoji 日本語 — em-dash";
	assert.equal(sanitizeEventText(text), text);
});

test("sanitizeEventText normalises CRLF to LF without losing lines", () => {
	assert.equal(sanitizeEventText("a\r\nb\r\nc"), "a\nb\nc");
});

test("sanitizeEventText is idempotent", () => {
	const payload = `${ESC}[2J${ESC}]0;t\u0007hello\r\nworld`;
	const once = sanitizeEventText(payload);
	assert.equal(sanitizeEventText(once), once);
});

test("sanitizeEventText refuses non-strings instead of passing objects through", () => {
	for (const value of [undefined, null, 42, {}, [], { text: "x" }]) {
		assert.equal(sanitizeEventText(value), "");
	}
});

test("SGR colour codes are dropped entirely (no styling from the stream)", () => {
	assert.equal(sanitizeEventText(`${ESC}[31mred${ESC}[0m text`), "red text");
});

/** Register one agent so the ingest methods have somewhere to append. */
function registryWithAgent() {
	const registry = new AgentRegistry();
	const sessionId = "cloudmode-test-session-0000000000000000";
	registry.add({
		sessionId,
		storyId: "SEC-01",
		status: "running",
		startedAt: Date.now(),
		transcript: [],
	});
	return { registry, sessionId };
}

test("appendTranscript sanitises at the ingest chokepoint", () => {
	const { registry, sessionId } = registryWithAgent();
	registry.appendTranscript(sessionId, {
		kind: "toolResult",
		text: `${ESC}[2J${ESC}]0;pwned\u0007tool output\rOVERWRITTEN`,
	});
	const [entry] = registry.get(sessionId).transcript;
	assert.ok(!entry.text.includes(ESC), "ESC reached the transcript buffer");
	assert.ok(!entry.text.includes("\u0007"), "BEL reached the transcript buffer");
	assert.ok(!entry.text.includes("\r"), "CR reached the transcript buffer");
	assert.ok(entry.text.includes("tool output"), "readable content was lost");
});

test("appendDelta sanitises every chunk, including split sequences", () => {
	const { registry, sessionId } = registryWithAgent();
	// A sequence deliberately split across chunk boundaries must not reassemble.
	for (const chunk of [`thinking ${ESC}`, "[2J more", `${ESC}]0;x\u0007 end`]) {
		registry.appendDelta(sessionId, "thinking", chunk);
	}
	const text = registry
		.get(sessionId)
		.transcript.map((e) => e.text)
		.join("");
	assert.ok(!text.includes(ESC), "ESC survived delta ingest");
	assert.ok(!text.includes("\u0007"), "BEL survived delta ingest");
	assert.ok(text.includes("thinking"), "readable delta content was lost");
	assert.ok(text.includes("end"), "trailing delta content was lost");
});

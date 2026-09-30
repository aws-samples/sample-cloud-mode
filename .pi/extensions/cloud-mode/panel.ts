// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Mode live overlay panel.
 *
 * Renders the selected agent's transcript in a focused overlay that updates
 * live: it subscribes to the registry and calls `tui.requestRender()` whenever a
 * streamed event lands, so you watch the agent work in real time. Crucially it
 * NEVER switches your pi session — pressing esc just closes the overlay and you
 * are back in your local session exactly where you left it.
 *
 * Keys: ←/→ or p/n cycle agents · ↑/↓ or j/k scroll · g/G top/bottom ·
 *       s steer · x stop · esc/q close.
 */

import type { KeybindingsManager, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type AgentRegistry, type CloudAgent, statusGlyph, type TranscriptEntry } from "./registry.ts";

export type PanelResult =
	| { type: "close" }
	| { type: "steer"; sessionId: string }
	| { type: "stop"; sessionId: string };

// pi's own "working" spinner: braille frames advanced every 80ms. Reused here so
// a running agent animates identically to the local pi working indicator.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

const KIND_COLOR: Record<TranscriptEntry["kind"], ThemeColor> = {
	user: "userMessageText",
	assistant: "text",
	thinking: "muted",
	tool: "toolTitle",
	toolResult: "toolOutput",
	status: "accent",
	pr: "success",
	error: "error",
	note: "muted",
};

const KIND_PREFIX: Record<TranscriptEntry["kind"], string> = {
	user: "› ",
	assistant: "",
	thinking: "· ",
	tool: "",
	toolResult: "",
	status: "",
	pr: "",
	error: "",
	note: "",
};

export class CloudModePanel implements Component {
	private selectedIndex: number;
	private scrollOffset = 0;
	private stickToBottom = true;
	private unsubscribe: () => void;
	private spinnerFrame = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly registry: AgentRegistry,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly done: (result: PanelResult) => void,
		initialSessionId?: string,
	) {
		const idx = initialSessionId ? this.registry.indexOf(initialSessionId) : 0;
		this.selectedIndex = idx >= 0 ? idx : 0;
		this.unsubscribe = this.registry.subscribe(() => this.tui.requestRender());
		// Drive the working spinner. Only request a re-render while some agent is
		// still non-terminal, so a panel full of finished agents stays idle.
		this.spinnerTimer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
			if (this.registry.activeCount() > 0) this.tui.requestRender();
		}, SPINNER_INTERVAL_MS);
	}

	dispose(): void {
		this.unsubscribe();
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
	}

	/** Animated spinner frame for running agents; the static glyph otherwise. */
	private glyphFor(agent: CloudAgent): string {
		return this.registry.isTerminal(agent.status) ? statusGlyph(agent.status) : SPINNER_FRAMES[this.spinnerFrame];
	}

	private agents(): CloudAgent[] {
		return this.registry.list();
	}

	private current(): CloudAgent | undefined {
		const agents = this.agents();
		if (agents.length === 0) return undefined;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, agents.length - 1));
		return agents[this.selectedIndex];
	}

	private bodyHeight(): number {
		// Box chrome is 6 rows (top border, title, rule, rule, footer, bottom
		// border); use every remaining row so the opaque box fills the screen.
		const avail = (this.tui.terminal?.rows ?? 24) - 6;
		return Math.max(6, avail);
	}

	handleInput(data: string): void {
		const agents = this.agents();
		if (matchesKey(data, Key.escape) || data === "q") {
			this.done({ type: "close" });
			return;
		}
		if (matchesKey(data, Key.left) || data === "p" || data === "[") {
			this.selectedIndex = (this.selectedIndex - 1 + agents.length) % Math.max(1, agents.length);
			this.resetScroll();
		} else if (matchesKey(data, Key.right) || data === "n" || data === "]" || matchesKey(data, Key.tab)) {
			this.selectedIndex = (this.selectedIndex + 1) % Math.max(1, agents.length);
			this.resetScroll();
		} else if (matchesKey(data, Key.up) || data === "k") {
			this.scrollBy(-1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			this.scrollBy(1);
		} else if (data === "g") {
			this.scrollOffset = 0;
			this.stickToBottom = false;
		} else if (data === "G") {
			this.stickToBottom = true;
		} else if (data === "s") {
			const cur = this.current();
			if (cur) this.done({ type: "steer", sessionId: cur.sessionId });
			return;
		} else if (data === "x") {
			const cur = this.current();
			if (cur && !this.registry.isTerminal(cur.status)) this.done({ type: "stop", sessionId: cur.sessionId });
			return;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private resetScroll(): void {
		this.scrollOffset = 0;
		this.stickToBottom = true;
	}

	private scrollBy(delta: number): void {
		this.stickToBottom = false;
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
	}

	invalidate(): void {
		/* stateless render; nothing cached */
	}

	private bodyLines(agent: CloudAgent, width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		for (const entry of agent.transcript) {
			const colorKey = KIND_COLOR[entry.kind];
			const prefix = KIND_PREFIX[entry.kind];
			const raw = prefix + entry.text;
			// Split on hard newlines first, then wrap each logical line to width.
			for (const logical of raw.split("\n")) {
				const wrappedLines = logical.length === 0 ? [""] : wrapTextWithAnsi(logical, width);
				for (const wrapped of wrappedLines) {
					lines.push(t.fg(colorKey, wrapped));
				}
			}
			lines.push("");
		}
		if (lines.length === 0) {
			lines.push(t.fg("dim", agent.status === "starting" ? "Launching agent…" : "Waiting for the agent to produce output…"));
		}
		return lines;
	}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width);
		// Box chrome eats 4 columns: "│ " ... " │".
		const contentWidth = Math.max(6, inner - 4);
		const agents = this.agents();

		let title = t.fg("muted", "no agents");
		let footer = "esc close";
		const body: string[] = [];

		if (agents.length === 0) {
			body.push("");
			body.push(t.fg("muted", "No cloud agents yet. Use the delegate_story tool to launch one."));
		} else {
			const agent = this.current()!;
			const pos = `${this.selectedIndex + 1}/${agents.length}`;
			const pr = agent.prUrl ? " · PR ✓" : agent.commitSha ? ` · merged ✓ ${agent.commitSha.slice(0, 7)}` : "";
			const err = agent.errorMessage ? ` · ${agent.errorMessage}` : "";
			const running = !this.registry.isTerminal(agent.status);
			const glyph = running
				? this.theme.fg("accent", this.glyphFor(agent))
				: this.theme.fg(agent.status === "failed" ? "error" : "success", this.glyphFor(agent));
			title =
				t.fg("accent", t.bold(`[${pos}] `)) +
				`${glyph} ` +
				t.fg("text", agent.headline) +
				t.fg("muted", ` — ${agent.status}${pr}`) +
				(err ? t.fg("error", err) : "");

			const bodyHeight = this.bodyHeight();
			// Reserve the bottom row for a sticky, animated "working…" indicator while
			// the selected agent runs — mirroring pi's own working label.
			const transcriptRows = running ? Math.max(1, bodyHeight - 1) : bodyHeight;
			const all = this.bodyLines(agent, contentWidth);
			const maxOffset = Math.max(0, all.length - transcriptRows);
			if (this.stickToBottom) this.scrollOffset = maxOffset;
			this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
			const visible = all.slice(this.scrollOffset, this.scrollOffset + transcriptRows);
			while (visible.length < transcriptRows) visible.push("");
			body.push(...visible);
			if (running) {
				body.push(t.fg("accent", `${this.glyphFor(agent)} working…`));
			}

			const scrollInfo = maxOffset > 0 ? ` · ${this.scrollOffset}/${maxOffset}` : "";
			footer = `←/→ agent · ↑/↓ scroll · g/G top/bottom · s steer · x stop · esc close${scrollInfo}`;
		}

		return this.frame(title, body, footer, contentWidth);
	}

	/**
	 * Wrap the panel in a solid bordered box so it is visually distinct from — and
	 * fully opaque over — the underlying pi UI. Overlays composite on top without
	 * clearing, so every row is padded to the exact box width and terminated with
	 * a border glyph: no trailing whitespace (which compositors trim, letting the
	 * background bleed through) and every interior cell is an opaque space/glyph.
	 */
	private frame(title: string, body: string[], footer: string, contentWidth: number): string[] {
		const t = this.theme;
		const b = (s: string) => t.fg("borderAccent", s);
		const dash = "─".repeat(contentWidth + 2);
		// A content row: "│ <content padded to contentWidth> │".
		const row = (content: string): string => {
			const w = visibleWidth(content);
			const cell = w > contentWidth ? truncateToWidth(content, contentWidth) : content + " ".repeat(contentWidth - w);
			return `${b("│")} ${cell} ${b("│")}`;
		};
		const out: string[] = [];
		out.push(b(`┌${dash}┐`));
		out.push(row(t.fg("accent", t.bold("☁ Cloud Mode")) + "  " + title));
		out.push(b(`├${dash}┤`));
		for (const line of body) out.push(row(line));
		out.push(b(`├${dash}┤`));
		out.push(row(t.fg("dim", footer)));
		out.push(b(`└${dash}┘`));
		return out;
	}
}

/** Factory helper matching the `ctx.ui.custom` signature. */
export function makePanel(
	registry: AgentRegistry,
	initialSessionId: string | undefined,
): (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: PanelResult) => void) => Component & {
	dispose?(): void;
} {
	return (tui, theme, _kb, done) => new CloudModePanel(registry, tui, theme, done, initialSessionId);
}

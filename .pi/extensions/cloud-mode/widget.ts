// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Mode editor widget — a compact, always-on, live status strip shown
 * above the input editor. It self-subscribes to the registry and requests a
 * re-render on every change, so you passively see agents progress without
 * opening anything. This is the "always-visible" half of the live experience;
 * the overlay panel (panel.ts) is the "full transcript" half.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type AgentRegistry, statusGlyph } from "./registry.ts";

const MAX_ROWS = 5;

export function makeWidget(
	registry: AgentRegistry,
	repoLabel: () => string,
): (tui: TUI, theme: Theme) => Component & { dispose?(): void } {
	return (tui, theme) => {
		const unsubscribe = registry.subscribe(() => tui.requestRender());
		return {
			dispose: unsubscribe,
			invalidate() {},
			render(width: number): string[] {
				const agents = registry.list();
				if (agents.length === 0) return [];
				const active = registry.activeCount();
				const header = theme.fg(
					"accent",
					`☁ cloud-mode · ${repoLabel()} · ${active} running / ${agents.length} agent(s)`,
				);
				const rows = [header];
				const limit = MAX_ROWS - 1;
				const shown = agents.slice(Math.max(0, agents.length - limit));
				for (const a of shown) {
					const glyph = statusGlyph(a.status);
					const pr = a.prUrl ? theme.fg("success", " PR✓") : a.commitSha ? theme.fg("success", " merged✓") : "";
					const color = a.status === "failed" ? "error" : a.status === "done" ? "success" : "muted";
					rows.push(theme.fg(color, `  ${glyph} ${a.headline} — ${a.status}`) + pr);
				}
				if (agents.length > limit) {
					rows.push(theme.fg("dim", `  …and ${agents.length - limit} more · /cloud-mode to view`));
				}
				return rows.map((r) => truncateToWidth(r, width));
			},
		};
	};
}

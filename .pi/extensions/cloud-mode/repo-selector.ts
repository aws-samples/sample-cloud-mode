// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive repo picker (arrow keys) backed by the local `gh` login.
 * Lets the user pick an existing repo or create a new one.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { SelectedRepo } from "./config.ts";
import { checkGhAuth, createRepo, currentLocalRepo, listRepos } from "./github.ts";

const CREATE_VALUE = "__create__";

/**
 * Show the picker. Returns the chosen/created repo, or undefined on cancel.
 * Requires TUI mode (guarded by caller).
 */
export async function pickRepo(ctx: ExtensionCommandContext, owner: string): Promise<SelectedRepo | undefined> {
	const authError = await checkGhAuth();
	if (authError) {
		ctx.ui.notify(authError, "error");
		return undefined;
	}

	let repos: Awaited<ReturnType<typeof listRepos>>;
	try {
		repos = await listRepos(owner);
	} catch (err) {
		ctx.ui.notify(`Failed to list repos for ${owner}: ${(err as Error).message}`, "error");
		return undefined;
	}

	const current = await currentLocalRepo();

	const items: SelectItem[] = [
		{ value: CREATE_VALUE, label: "➕ Create new repository…", description: `under ${owner}` },
		...repos.map((r) => ({
			value: r.nameWithOwner,
			label: r.nameWithOwner === current ? `${r.nameWithOwner}  (current)` : r.nameWithOwner,
			description: `${r.visibility} · updated ${r.updatedAt.slice(0, 10)}`,
		})),
	];

	// Preselect the current local repo if present.
	const preselectIndex = current ? items.findIndex((i) => i.value === current) : -1;

	const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Select target repository (${owner})`))));

		// Type-to-filter state. SelectList has no built-in typing support — we
		// collect printable chars ourselves, show them in a filter line, and feed
		// `owner/<filter>` to setFilter (which prefix-matches on item.value).
		let filter = "";
		const filterLine = new Text("");
		const renderFilterLine = () => {
			filterLine.setText(filter ? theme.fg("accent", `  filter: ${filter}█`) : theme.fg("dim", "  filter: (type to filter)"));
		};
		renderFilterLine();
		container.addChild(filterLine);

		const list = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		if (preselectIndex > 0 && typeof (list as unknown as { setSelectedIndex?: (n: number) => void }).setSelectedIndex === "function") {
			(list as unknown as { setSelectedIndex: (n: number) => void }).setSelectedIndex(preselectIndex);
		}
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel")));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				const isBackspace = data === "\x7f" || data === "\b";
				const isPrintable = data.length > 0 && !/[\x00-\x1f]/.test(data);
				if (isBackspace || isPrintable) {
					filter = isBackspace ? filter.slice(0, -1) : filter + data;
					list.setFilter(filter ? `${owner}/${filter}` : "");
					renderFilterLine();
				} else {
					list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});

	if (!choice) return undefined;

	if (choice === CREATE_VALUE) {
		return await createNewRepoFlow(ctx, owner);
	}

	const repo = repos.find((r) => r.nameWithOwner === choice);
	if (!repo) return undefined;
	return { nameWithOwner: repo.nameWithOwner, url: repo.url, defaultBranch: repo.defaultBranch };
}

async function createNewRepoFlow(ctx: ExtensionCommandContext, owner: string): Promise<SelectedRepo | undefined> {
	const name = (await ctx.ui.input("New repository name", "my-new-service"))?.trim();
	if (!name) return undefined;

	const visibility = await ctx.ui.select("Visibility", ["private", "public"]);
	if (!visibility) return undefined;

	try {
		const repo = await createRepo(owner, name, visibility as "private" | "public");
		ctx.ui.notify(`Created ${repo.nameWithOwner}`, "info");
		return repo;
	} catch (err) {
		ctx.ui.notify(`Failed to create repo: ${(err as Error).message}`, "error");
		return undefined;
	}
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub interaction via the locally authenticated `gh` CLI.
 *
 * No token handling in the extension: we reuse the user's existing `gh` login
 * (design decision — the picker lists repos with the user's own credentials).
 * The Fargate worker uses a *separate* GitHub App token (see worker/entrypoint.sh).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SelectedRepo } from "./config.ts";

const execFileAsync = promisify(execFile);

export interface RepoInfo {
	nameWithOwner: string;
	url: string;
	visibility: string;
	updatedAt: string;
	defaultBranch: string;
}

async function gh(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("gh", args, { maxBuffer: 10 * 1024 * 1024 });
	return stdout;
}

/** Verify `gh` is installed and authenticated. Returns an error string or null. */
export async function checkGhAuth(): Promise<string | null> {
	try {
		await execFileAsync("gh", ["auth", "status"]);
		return null;
	} catch (err) {
		const msg = (err as { stderr?: string }).stderr ?? (err as Error).message;
		return `gh CLI not authenticated. Run 'gh auth login'. (${msg?.trim()})`;
	}
}

/** List repos for an owner, most-recently-updated first. */
export async function listRepos(owner: string, limit = 200): Promise<RepoInfo[]> {
	const out = await gh([
		"repo",
		"list",
		owner,
		"--limit",
		String(limit),
		"--json",
		"nameWithOwner,url,visibility,updatedAt,defaultBranchRef",
	]);
	const raw = JSON.parse(out) as Array<{
		nameWithOwner: string;
		url: string;
		visibility: string;
		updatedAt: string;
		defaultBranchRef?: { name?: string } | null;
	}>;
	return raw
		.map((r) => ({
			nameWithOwner: r.nameWithOwner,
			url: `${r.url}.git`,
			visibility: (r.visibility ?? "").toLowerCase(),
			updatedAt: r.updatedAt,
			defaultBranch: r.defaultBranchRef?.name ?? "main",
		}))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Create a new repo and return it as a SelectedRepo. */
export async function createRepo(owner: string, name: string, visibility: "private" | "public"): Promise<SelectedRepo> {
	const full = `${owner}/${name}`;
	await gh(["repo", "create", full, `--${visibility}`, "--clone=false"]);
	// Fetch canonical metadata (URL + default branch).
	const out = await gh(["repo", "view", full, "--json", "url,defaultBranchRef"]);
	const parsed = JSON.parse(out) as { url: string; defaultBranchRef?: { name?: string } | null };
	return {
		nameWithOwner: full,
		url: `${parsed.url}.git`,
		defaultBranch: parsed.defaultBranchRef?.name ?? "main",
	};
}

/** Best-effort detection of the current local repo's nameWithOwner (for preselect). */
export async function currentLocalRepo(): Promise<string | undefined> {
	try {
		const out = await gh(["repo", "view", "--json", "nameWithOwner"]);
		return (JSON.parse(out) as { nameWithOwner?: string }).nameWithOwner;
	} catch {
		return undefined;
	}
}

/**
 * Branch-protection status of a repository's default branch.
 *
 * Cloud Mode deliberately removed human review of the diff (Tenet 2), so the
 * *only* thing standing between an autonomous agent and the default branch is a
 * machine gate: branch protection with required status checks. A repository
 * without it silently converts "review-free delivery" into "unreviewed,
 * ungated delivery" — which is why `delegate_story` treats this as a
 * precondition (threat model T-005 / T-023, open question 3).
 *
 * Returns:
 *   - `{ protected: true, requiredChecks: [...] }` when a gate exists;
 *   - `{ protected: false }` when the branch is unprotected;
 *   - `{ unknown: true, reason }` when it cannot be determined (no admin rights
 *     on the repo, `gh` not authenticated, API error). Unknown is reported, never
 *     silently treated as protected.
 *
 * `allowsForcePush` matters as much as the checks themselves: a protected branch
 * that still permits force pushes can be rewritten underneath in-flight agents,
 * which is how reverted code gets reintroduced by a later merge (T-021, observed
 * in practice as "Frankenstein" merges).
 */
export interface ProtectionStatus {
	protected?: boolean;
	requiredChecks?: string[];
	strict?: boolean;
	/** True when the protected branch still allows force pushes (T-021). */
	allowsForcePush?: boolean;
	/** True when the protected branch still allows deletion (T-021). */
	allowsDeletion?: boolean;
	unknown?: boolean;
	reason?: string;
}

export async function branchProtection(nameWithOwner: string, branch: string): Promise<ProtectionStatus> {
	try {
		const out = await gh(["api", `repos/${nameWithOwner}/branches/${encodeURIComponent(branch)}`]);
		const parsed = JSON.parse(out) as {
			protected?: boolean;
			protection?: {
				required_status_checks?: { contexts?: string[]; checks?: Array<{ context?: string }>; strict?: boolean };
				allow_force_pushes?: { enabled?: boolean };
				allow_deletions?: { enabled?: boolean };
			};
		};
		if (!parsed.protected) return { protected: false };
		const rsc = parsed.protection?.required_status_checks;
		const contexts = rsc?.contexts ?? rsc?.checks?.map((c) => c.context ?? "").filter(Boolean) ?? [];
		return {
			protected: true,
			requiredChecks: contexts,
			strict: rsc?.strict,
			allowsForcePush: parsed.protection?.allow_force_pushes?.enabled === true,
			allowsDeletion: parsed.protection?.allow_deletions?.enabled === true,
		};
	} catch (err) {
		const msg = ((err as { stderr?: string }).stderr ?? (err as Error).message ?? "").trim();
		return { unknown: true, reason: msg.slice(0, 300) };
	}
}

/**
 * How widely the GitHub App is installed for an owner.
 *
 * The installation scope IS the system's repository allow-list (A-05): every
 * threat in the model is repo-scoped or org-scoped depending on this single
 * setting, so "All repositories" turns one compromise into an org-wide one
 * (T-020). Reported, never enforced by us — only GitHub can enforce it.
 *
 * Returns `{ selection: "all" | "selected", repositoryCount? }`, or
 * `{ unknown: true, reason }` when the installation endpoint is not readable
 * with the local `gh` credentials.
 */
export interface InstallationScope {
	selection?: "all" | "selected";
	repositoryCount?: number;
	unknown?: boolean;
	reason?: string;
}

export async function installationScope(owner: string): Promise<InstallationScope> {
	try {
		const out = await gh(["api", `orgs/${owner}/installations`]);
		const parsed = JSON.parse(out) as {
			installations?: Array<{ repository_selection?: string; app_slug?: string }>;
		};
		const installs = parsed.installations ?? [];
		if (!installs.length) return { unknown: true, reason: "no installations visible for this owner" };
		// Any installation with org-wide scope is the one that matters for blast radius.
		const anyAll = installs.some((i) => i.repository_selection === "all");
		return { selection: anyAll ? "all" : "selected", repositoryCount: installs.length };
	} catch (err) {
		const msg = ((err as { stderr?: string }).stderr ?? (err as Error).message ?? "").trim();
		return { unknown: true, reason: msg.slice(0, 300) };
	}
}

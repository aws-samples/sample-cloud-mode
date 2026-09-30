// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Config loading for the Cloud Mode extension (Bedrock AgentCore backend).
 *
 * Two-stage resolution:
 *   1. Base config from project-local `.pi/cloud-mode.json` (only when trusted).
 *   2. Environment variables override individual fields.
 *
 * The *selected repo* is stored separately in `.pi/cloud-mode.state.json` so we
 * never clobber the user-authored config file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SelectedRepo {
	/** e.g. "example-org/my-service" */
	nameWithOwner: string;
	/** clone URL (https) */
	url: string;
	/** default branch, used as PR base */
	defaultBranch: string;
}

/**
 * How a completed story is delivered:
 *   - "pull-request" (default): commit to a story branch and open a PR.
 *   - "direct-merge": land the story's commit(s) straight on the repo's default
 *     branch with no PR (review-free / dark-launch workflows).
 */
export type DeliveryMode = "pull-request" | "direct-merge";

export const DELIVERY_MODES: readonly DeliveryMode[] = ["pull-request", "direct-merge"];
export const DEFAULT_DELIVERY_MODE: DeliveryMode = "pull-request";

export interface CloudModeConfig {
	region: string;
	/** ARN of the deployed AgentCore Runtime. */
	agentRuntimeArn: string;
	/** Endpoint qualifier (defaults to "DEFAULT"). */
	qualifier: string;
	/** GitHub owner/org whose repos are listed in the picker. */
	githubOwner: string;
	/** Hard cap on concurrent agents (cost guard). */
	maxConcurrentAgents: number;
	/** How completed stories are delivered (defaults to "pull-request"). */
	deliveryMode: DeliveryMode;
	/**
	 * Refuse to delegate into a default branch that has no branch protection with
	 * required status checks (defaults to true). Cloud Mode replaces human review
	 * of the diff with machine gates, so an unprotected branch means the delivery
	 * is neither reviewed nor gated (threat model T-005 / T-023).
	 */
	requireBranchProtection: boolean;
	/**
	 * Repositories this project may delegate to, as `owner/name` (case-insensitive;
	 * `owner/*` wildcards allowed). `delegate_story` is an **LLM-callable** tool:
	 * the repo it targets and the story text both come out of a model turn, so
	 * without an allow-list a confused or prompt-injected local model can spend the
	 * operator's GitHub write access on a repository they never chose
	 * (threat model T-025 / M-035).
	 *
	 * Absent ⇒ the current project's selected repository only.
	 */
	delegableRepos: string[];
	/**
	 * Skip the pre-launch confirmation prompt (batch/unattended use). Documented
	 * escape hatch: it never bypasses `delegableRepos`.
	 */
	autoConfirm: boolean;
	/** Currently selected target repo, if any. */
	repo?: SelectedRepo;
}

export interface ConfigResult {
	config?: CloudModeConfig;
	/** Present when config could not be fully resolved. */
	error?: string;
}

const CONFIG_FILE = "cloud-mode.json";
const STATE_FILE = "cloud-mode.state.json";

interface RawConfig {
	region?: string;
	agentRuntimeArn?: string;
	qualifier?: string;
	githubOwner?: string;
	maxConcurrentAgents?: number;
	deliveryMode?: string;
	requireBranchProtection?: boolean;
	delegableRepos?: unknown;
	autoConfirm?: boolean;
}

/**
 * Does `candidate` (owner/name) match one of the allow-list patterns?
 * Patterns are case-insensitive and may use a single trailing `*` wildcard for
 * the repository part (`owner/*`). No pattern ever matches across owners.
 */
export function repoAllowed(candidate: string, patterns: string[]): boolean {
	const target = candidate.trim().toLowerCase();
	if (!target.includes("/")) return false;
	for (const raw of patterns) {
		const pattern = String(raw ?? "")
			.trim()
			.toLowerCase();
		if (!pattern) continue;
		if (pattern === target) return true;
		const [pOwner, pRepo] = pattern.split("/", 2);
		const [tOwner, tRepo] = target.split("/", 2);
		if (pOwner !== tOwner || !pRepo || !tRepo) continue;
		if (pRepo === "*") return true;
		if (pRepo.endsWith("*") && tRepo.startsWith(pRepo.slice(0, -1))) return true;
	}
	return false;
}

/** Parse the raw allow-list; a non-array or empty value means "use the default". */
function parseDelegableRepos(value: unknown, fallback?: string): string[] {
	const fromEnv = process.env.CLOUD_MODE_DELEGABLE_REPOS;
	const source = fromEnv !== undefined ? fromEnv.split(",") : value;
	const list = Array.isArray(source)
		? source.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0 && v.includes("/"))
		: [];
	if (list.length) return list;
	// Default: only the repository this project is pointed at. A delegation to
	// anything else must be an explicit, written-down decision (T-025).
	return fallback ? [fallback] : [];
}

/**
 * Validate a raw deliveryMode value. Absent ⇒ default ("pull-request").
 * Unknown strings are rejected with a clear, actionable error.
 */
export function parseDeliveryMode(value: unknown): { mode?: DeliveryMode; error?: string } {
	if (value === undefined || value === null || value === "") return { mode: DEFAULT_DELIVERY_MODE };
	if (typeof value === "string" && (DELIVERY_MODES as readonly string[]).includes(value)) {
		return { mode: value as DeliveryMode };
	}
	return {
		error: `Invalid deliveryMode ${JSON.stringify(value)}. Expected one of: ${DELIVERY_MODES.map((m) => `"${m}"`).join(", ")}.`,
	};
}

function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

/**
 * Load and validate config. `trusted` gates reading the project-local file.
 */
export function loadConfig(cwd: string, configDirName: string, trusted: boolean): ConfigResult {
	const configDir = join(cwd, configDirName);
	const raw: RawConfig = (trusted ? readJson<RawConfig>(join(configDir, CONFIG_FILE)) : undefined) ?? {};
	const repo = trusted ? readJson<{ repo?: SelectedRepo }>(join(configDir, STATE_FILE))?.repo : undefined;

	const deliveryRaw = process.env.CLOUD_MODE_DELIVERY_MODE ?? raw.deliveryMode;
	const delivery = parseDeliveryMode(deliveryRaw);

	const merged: CloudModeConfig = {
		region: process.env.CLOUD_MODE_REGION ?? raw.region ?? "",
		agentRuntimeArn: process.env.CLOUD_MODE_RUNTIME_ARN ?? raw.agentRuntimeArn ?? "",
		qualifier: process.env.CLOUD_MODE_QUALIFIER ?? raw.qualifier ?? "DEFAULT",
		githubOwner: process.env.CLOUD_MODE_GITHUB_OWNER ?? raw.githubOwner ?? "",
		maxConcurrentAgents: Number(process.env.CLOUD_MODE_MAX_AGENTS ?? raw.maxConcurrentAgents ?? 5),
		deliveryMode: delivery.mode ?? DEFAULT_DELIVERY_MODE,
		// Fail closed by default: an ungated default branch is opted into, never
		// defaulted into.
		requireBranchProtection: process.env.CLOUD_MODE_REQUIRE_BRANCH_PROTECTION
			? !/^(0|false|no)$/i.test(process.env.CLOUD_MODE_REQUIRE_BRANCH_PROTECTION)
			: (raw.requireBranchProtection ?? true),
		delegableRepos: parseDelegableRepos(raw.delegableRepos, repo?.nameWithOwner),
		autoConfirm: process.env.CLOUD_MODE_AUTO_CONFIRM
			? /^(1|true|yes)$/i.test(process.env.CLOUD_MODE_AUTO_CONFIRM)
			: (raw.autoConfirm ?? false),
		repo,
	};

	// An invalid deliveryMode is a hard config error — never silently fall back.
	if (delivery.error) {
		return {
			config: merged,
			error: `${delivery.error} Fix ${join(configDirName, CONFIG_FILE)} (or CLOUD_MODE_DELIVERY_MODE).`,
		};
	}

	const missing: string[] = [];
	if (!merged.region) missing.push("region");
	if (!merged.agentRuntimeArn) missing.push("agentRuntimeArn");
	if (!merged.githubOwner) missing.push("githubOwner");

	if (missing.length > 0) {
		return {
			config: merged,
			error: `Incomplete cloud-mode config. Missing: ${missing.join(", ")}. Configure ${join(configDirName, CONFIG_FILE)} or CLOUD_MODE_* env vars.`,
		};
	}
	return { config: merged };
}

/** Persist the selected repo into `.pi/cloud-mode.state.json`. */
export function saveSelectedRepo(cwd: string, configDirName: string, repo: SelectedRepo): void {
	const dir = join(cwd, configDirName);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, STATE_FILE);
	writeFileSync(path, `${JSON.stringify({ repo }, null, 2)}\n`, "utf-8");
}

/**
 * Persist the base config to `.pi/cloud-mode.json` (written by the setup
 * wizard). Only the user-authored fields are stored — never `repo`, which
 * lives in the state file.
 */
export function saveConfig(
	cwd: string,
	configDirName: string,
	cfg: Pick<
		CloudModeConfig,
		"region" | "agentRuntimeArn" | "qualifier" | "githubOwner" | "maxConcurrentAgents" | "deliveryMode"
	>,
): string {
	const dir = join(cwd, configDirName);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, CONFIG_FILE);
	const body: RawConfig = {
		region: cfg.region,
		agentRuntimeArn: cfg.agentRuntimeArn,
		qualifier: cfg.qualifier,
		githubOwner: cfg.githubOwner,
		maxConcurrentAgents: cfg.maxConcurrentAgents,
		deliveryMode: cfg.deliveryMode,
	};
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf-8");
	return path;
}

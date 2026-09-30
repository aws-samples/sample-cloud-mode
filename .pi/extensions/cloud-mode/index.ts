// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Mode — Pi extension entry point (Bedrock AgentCore backend).
 *
 * NEW APPROACH — "live overlay, never switch sessions":
 *
 * The previous design turned every delegated story into a separate pi session
 * file and *switched* your whole pi session over to watch it. That had two fatal
 * UX problems: (1) pi caches a loaded session file and won't re-read it while
 * live, so a running agent only ever showed a stale snapshot ("I'm not seeing
 * any updating event"); and (2) switching hijacked your session, so getting back
 * to your own local pi was clunky ("I can't go back to my local pi").
 *
 * This version keeps agents entirely out of the session system. Each agent has
 * an in-memory transcript buffer that the SSE stream appends to; the registry is
 * a tiny pub/sub. Two live views render it:
 *   - a persistent editor **widget** (always-on status strip), and
 *   - a focused **overlay panel** (`/cloud-mode`) showing the full transcript.
 * Both re-render the instant an event lands (`tui.requestRender()`), so updates
 * are truly live with no manual refresh — and pressing `esc` closes the overlay,
 * dropping you straight back into your untouched local pi session.
 *
 * Capabilities:
 *   - `delegate_story` tool — launch an isolated AgentCore sub-agent for a story.
 *   - `/cloud-mode` (alt+g) — open the live overlay panel.
 *   - `/cloud-mode-stop` — stop a running agent.
 *   - `/cloud-mode-repo` — arrow-key repo picker (existing or create new).
 *   - `/cloud-mode-setup` — interactive onboarding wizard (fixes config, GitHub App,
 *     repo selection in place); read-only doctor report in non-TUI modes.
 *
 * Inside the panel: ←/→ cycle agents · ↑/↓ scroll · g/G top/bottom ·
 * s steer the focused agent · x stop it · esc/q close.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stopRuntimeSession } from "./agentcore.ts";
import { makeDemoStories, runDemoScript } from "./demo-emitter.ts";
import { type CloudModeConfig, loadConfig, repoAllowed, saveSelectedRepo } from "./config.ts";
import { branchProtection, installationScope } from "./github.ts";
import { callerIdentity, forgetOwnerToken, mintOwnerToken } from "./identity.ts";
import { makePanel, type PanelResult } from "./panel.ts";
import { AgentRegistry, type CloudAgent, statusGlyph } from "./registry.ts";
import { pickRepo } from "./repo-selector.ts";
import { runDoctor, runWizard } from "./setup.ts";
import { consumeStream } from "./stream.ts";
import { runTestEmitter } from "./test-emitter.ts";
import { makeWidget } from "./widget.ts";

const AGENT_STATE_TYPE = "cloud-mode-agent";
const WIDGET_KEY = "cloud-mode";

// ── Module-scoped agent state (survives session switches / reloads) ─────────
// The extension factory runs once per session; keeping agent state on the module
// means in-flight streams (started from a delegate call) keep producing events
// regardless of what the user does in their own session.
const registry = new AgentRegistry();
const streams = new Map<string, AbortController>();
/** Last agent the user viewed, so re-opening the panel lands on it. */
let lastViewedSessionId: string | undefined;
/**
 * The GitHub App's installation scope is warned about once per pi session
 * (T-020): repeating it on every delegation would train the operator to ignore
 * it, which is worse than not warning at all.
 */
let installScopeWarned = false;

interface PersistedAgent {
	sessionId: string;
	storyId: string;
	headline: string;
	description: string;
	startedAt: number;
}

export const DelegateStoryParams = Type.Object({
	storyId: Type.String({ description: "Short unique id/slug for the story, e.g. 'STORY-42'." }),
	description: Type.String({ description: "Full user story text the sub-agent should solve." }),
});

export default function cloudMode(pi: ExtensionAPI) {
	let config: CloudModeConfig | undefined;
	let configError: string | undefined;

	function reloadConfig(ctx: ExtensionContext): void {
		const res = loadConfig(ctx.cwd, CONFIG_DIR_NAME, ctx.isProjectTrusted());
		config = res.config;
		configError = res.error;
	}

	function repoLabel(): string {
		return config?.repo?.nameWithOwner ?? "no repo";
	}

	function restoreAgents(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type: string;
			customType?: string;
			data?: PersistedAgent;
		}>;
		for (const e of entries) {
			if (e.type !== "custom" || e.customType !== AGENT_STATE_TYPE || !e.data) continue;
			const p = e.data;
			if (registry.get(p.sessionId)) continue;
			// Restored across a restart: the live stream is gone and the transcript
			// was in-memory only, so we surface it as a terminal snapshot.
			registry.add({
				sessionId: p.sessionId,
				storyId: p.storyId,
				headline: p.headline,
				description: p.description,
				status: "done",
				startedAt: p.startedAt,
				transcript: [
					{
						kind: "note",
						text: "ℹ️ Restored from a previous session — live transcript is not available.",
						timestamp: Date.now(),
					},
				],
			});
		}
	}

	function updateStatusLine(ctx: ExtensionContext): void {
		try {
			if (configError) {
				ctx.ui.setStatus("cloud-mode", ctx.ui.theme.fg("warning", "cloud-mode: not configured"));
				return;
			}
			const active = registry.activeCount();
			const total = registry.list().length;
			ctx.ui.setStatus(
				"cloud-mode",
				ctx.ui.theme.fg("accent", `cloud-mode: ${repoLabel()} · ${active} running / ${total} agent(s)`),
			);
		} catch {
			/* stale ctx guard */
		}
	}

	function installWidget(ctx: ExtensionContext): void {
		try {
			// Installed once per session; the widget component self-subscribes to the
			// registry and renders [] (invisible) whenever there are no agents, so we
			// never toggle it (which would churn subscriptions).
			ctx.ui.setWidget(WIDGET_KEY, makeWidget(registry, repoLabel), { placement: "aboveEditor" });
		} catch {
			/* stale ctx guard */
		}
	}

	function headlineFor(storyId: string, description: string): string {
		const firstLine = description.split("\n")[0].trim();
		const short = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
		return short ? `${storyId}: ${short}` : storyId;
	}

	/** Start (or steer) an agent's stream in the background. */
	function startStream(agent: CloudAgent, payload: Record<string, unknown>, ctx: ExtensionContext): void {
		const controller = new AbortController();
		const key = `${agent.sessionId}:${Date.now()}`;
		streams.set(key, controller);
		void consumeStream({
			config: config!,
			sessionId: agent.sessionId,
			payload,
			registry,
			signal: controller.signal,
			onChange: () => updateStatusLine(ctx),
			onError: (m) => {
				try {
					ctx.ui.notify(`Cloud agent '${agent.storyId}': ${m}`, "warning");
				} catch {
					/* stale ctx guard */
				}
			},
		}).finally(() => {
			streams.delete(key);
		});
	}

	/** Whether a background stream (live or self-polling) is running for an agent. */
	function abortStreams(sessionId: string): void {
		for (const [key, ctrl] of streams) {
			if (key.startsWith(`${sessionId}:`)) {
				ctrl.abort();
				streams.delete(key);
			}
		}
	}

	// ── Tool: delegate_story ────────────────────────────────────────────────
	pi.registerTool({
		name: "delegate_story",
		label: "Delegate Story",
		description:
			"Launch an isolated Bedrock AgentCore sub-agent that clones the configured target repo in a dedicated worktree, solves the given user story, and delivers the result per the project's deliveryMode config (opens a pull request, or merges directly to the default branch). View progress inline with /cloud-mode.",
		promptSnippet: "Delegate a user story to an isolated cloud sub-agent (opens a PR or merges to the default branch, per config).",
		promptGuidelines: [
			"Use delegate_story to hand off a self-contained user story to a remote sub-agent; each call costs money, so batch only genuinely independent stories.",
		],
		parameters: DelegateStoryParams,
		// Sequential, not parallel: multiple delegate_story calls in one assistant
		// turn mutate shared launch state (registry, concurrency cap, persisted
		// entries). Running one at a time makes each story launch in order and keeps
		// the concurrency check race-free.
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reloadConfig(ctx);
			if (!config || configError) {
				return err(`Cannot delegate: ${configError ?? "config not loaded"}`);
			}
			if (!ctx.isProjectTrusted()) {
				return err("Project is not trusted; refusing to launch cloud agents.");
			}
			if (!config.repo) {
				return err("No target repo selected. Ask the user to run /cloud-mode-repo first.");
			}
			if (registry.hasStory(params.storyId)) {
				return err(`Story '${params.storyId}' already delegated.`);
			}
			if (registry.activeCount() >= config.maxConcurrentAgents) {
				return err(`Concurrency limit reached (${config.maxConcurrentAgents} active agents). Try again later.`);
			}

			// ── delegate_story is a privileged action (T-025 / M-035) ─────────────
			// This tool is invoked by the *model*, and both the target repo and the story
			// text originate in a model turn. Two controls sit between that call and a
			// session that can write to GitHub: a configured allow-list, and — unless the
			// operator opted out — a confirmation showing the RESOLVED facts, so what is
			// approved is what will actually run.
			const target = config.repo.nameWithOwner;
			if (!repoAllowed(target, config.delegableRepos)) {
				return err(
					`Refusing to delegate: '${target}' is not in this project's delegableRepos allow-list ` +
						`(${config.delegableRepos.join(", ") || "empty"}). Add it to "delegableRepos" in ` +
						`.pi/cloud-mode.json (or CLOUD_MODE_DELEGABLE_REPOS) if you really intend to let this ` +
						`project delegate there.`,
				);
			}
			if (!config.autoConfirm && typeof ctx.ui?.confirm === "function") {
				const preview = params.description.replace(/\s+/g, " ").slice(0, 200);
				const approved = await ctx.ui.confirm(
					`Delegate '${params.storyId}' to a cloud agent?`,
					[
						`Repository:  ${target}`,
						`Base branch: ${config.repo.defaultBranch}`,
						`Delivery:    ${config.deliveryMode}`,
						`Story:       ${preview}${params.description.length > 200 ? "…" : ""}`,
						"",
						"The agent writes to this repository without human review of the diff.",
					].join("\n"),
				);
				if (!approved) {
					return err(
						`Delegation of '${params.storyId}' to ${target} was declined by the operator; nothing was launched.`,
					);
				}
			}

			// Machine gate as a PRECONDITION, not a recommendation (threat model
			// T-005/T-023, open question 3). Cloud Mode deliberately removed human
			// review of the diff, so delivering into a default branch with no branch
			// protection and no required checks would mean *nothing* gates the agent's
			// output. Refuse by default; the operator can opt out per project with
			// `requireBranchProtection: false` (or CLOUD_MODE_REQUIRE_BRANCH_PROTECTION=0)
			// and then owns that risk explicitly.
			// Escape-hatch bookkeeping (T-027 / M-037): when we launch without an
			// enforced machine gate, the worker must know — it stamps the fact into the
			// commit trailer and the PR body so an ungated delivery stays recognisable
			// long after this terminal is closed.
			let branchProtectionWaived: string | undefined;
			if (config.requireBranchProtection) {
				const prot = await branchProtection(config.repo.nameWithOwner, config.repo.defaultBranch);
				const target = `${config.repo.nameWithOwner}@${config.repo.defaultBranch}`;
				if (prot.protected === false) {
					return err(
						`Refusing to delegate: ${target} has no branch protection, so nothing would gate the ` +
							`agent's changes (Cloud Mode replaces human review with machine gates). ` +
							`Enable branch protection with required status checks, or set ` +
							`"requireBranchProtection": false in .pi/cloud-mode.json to accept an ungated branch.`,
					);
				}
				if (prot.protected && (prot.requiredChecks?.length ?? 0) === 0) {
					return err(
						`Refusing to delegate: ${target} is protected but has NO required status checks, so a green ` +
							`CI run is not a precondition for merging. Add required checks, or set ` +
							`"requireBranchProtection": false in .pi/cloud-mode.json.`,
					);
				}
				if (prot.protected && prot.allowsForcePush) {
					// A branch that can be force-pushed can be rewritten underneath agents
					// that are already in flight, which is how reverted code gets
					// reintroduced by a later merge (T-021, observed in practice).
					return err(
						`Refusing to delegate: ${target} is protected but still ALLOWS FORCE PUSHES, so the branch ` +
							`agents branched from can be rewritten under them (reverted code reappears in a later ` +
							`merge). Disable "Allow force pushes" in the branch protection rule, or set ` +
							`"requireBranchProtection": false in .pi/cloud-mode.json to accept that risk.`,
					);
				}
				if (prot.unknown) {
					// Cannot verify (no admin rights / gh not authenticated). Proceed, but
					// say so — a silent "assume protected" would be the exact failure mode
					// this check exists to prevent.
					branchProtectionWaived = `branch protection on ${target} could not be verified (${prot.reason ?? "unknown error"})`;
					ctx.ui?.notify?.(
						`Could not verify branch protection on ${target} (${prot.reason ?? "unknown error"}). ` +
							`Delegating anyway — the server-side gate is unverified.`,
						"warn",
					);
				}
			} else {
				branchProtectionWaived = `requireBranchProtection: false in .pi/cloud-mode.json`;
				ctx.ui?.notify?.(
					`Delegating with the branch-protection precondition disabled — this delivery will be marked ` +
						`as ungated in its commit trailer and PR body.`,
					"warn",
				);
			}

			// Installation scope is the system's repository allow-list (A-05): "All
			// repositories" turns every repo-scoped threat in the model into an org-scoped
			// one (T-020). Warn once per pi session — per delegation would be noise the
			// operator learns to ignore, which is worse than not warning.
			if (!installScopeWarned) {
				installScopeWarned = true;
				void installationScope(config.githubOwner)
					.then((scope) => {
						if (scope.selection === "all") {
							ctx.ui?.notify?.(
								`⚠️  The Cloud Mode GitHub App is installed on ALL repositories of '${config?.githubOwner}'. ` +
									`Every risk in this system is now org-scoped: one prompt injection or one leaked ` +
									`credential reaches every repo. This is NOT a supported configuration — reinstall the App ` +
									`with "Only select repositories" and list just the repos Cloud Mode may write to.`,
								"warning",
							);
						} else if (scope.unknown) {
							ctx.ui?.notify?.(
								`Could not verify the GitHub App's installation scope (${scope.reason ?? "unknown error"}). ` +
									`If it is installed on "All repositories", the blast radius is org-wide.`,
								"warning",
							);
						}
					})
					.catch(() => {
						/* advisory only — never block a launch on this check */
					});
			}

			// Launches are unattended: delegating a batch of stories must never stall
			// waiting for a click. The cost guard rails are `maxConcurrentAgents`
			// (checked above) and the duplicate-story check — not a per-launch prompt.

			try {
				const sessionId = `cloudmode-${randomUUID()}${randomUUID().replace(/-/g, "")}`.slice(0, 90);
				// Session-hijack protection (T-002 / M-020): a secret that stays in this
				// process and is replayed on attach/steer, so the session id alone is not
				// a capability any more.
				mintOwnerToken(sessionId);
				// Attribution for forensics (T-009 / M-024); never used for authorization.
				const delegatedBy = await callerIdentity();
				const headline = headlineFor(params.storyId, params.description);

				const agent: CloudAgent = {
					sessionId,
					storyId: params.storyId,
					headline,
					description: params.description,
					status: "starting",
					startedAt: Date.now(),
					transcript: [],
				};
				registry.add(agent);
				lastViewedSessionId = sessionId;

				pi.appendEntry<PersistedAgent>(AGENT_STATE_TYPE, {
					sessionId,
					storyId: agent.storyId,
					headline,
					description: agent.description,
					startedAt: agent.startedAt,
				});

				startStream(
					agent,
					{
						action: "start",
						storyId: params.storyId,
						userStory: params.description,
						repoUrl: config.repo.url,
						repoNwo: config.repo.nameWithOwner,
						baseBranch: config.repo.defaultBranch,
						deliveryMode: config.deliveryMode,
						delegatedBy,
						...(branchProtectionWaived ? { branchProtectionWaived } : {}),
					},
					ctx,
				);
				updateStatusLine(ctx);

				const deliveryNote =
					config.deliveryMode === "direct-merge"
						? `it will merge directly to ${config.repo.defaultBranch} (no PR); the commit SHA appears when it finishes.`
						: "a PR link appears when it finishes.";
				return {
					content: [
						{
							type: "text",
							text: `Launched cloud sub-agent for '${params.storyId}' on ${config.repo.nameWithOwner} (delivery: ${config.deliveryMode}).\nRun /cloud-mode (alt+g) to watch it live; ${deliveryNote}`,
						},
					],
					details: { sessionId, deliveryMode: config.deliveryMode },
				};
			} catch (e) {
				return err(`Failed to launch agent: ${(e as Error).message}`);
			}
		},
	});

	// ── Command: /cloud-mode-setup (onboarding wizard / doctor) ─────────────────
	pi.registerCommand("cloud-mode-setup", {
		description: "Set up Cloud Mode interactively (config, GitHub App, repo) and verify all requirements",
		handler: async (_args, ctx) => {
			reloadConfig(ctx);
			const emitReport = (report: string) =>
				pi.sendMessage({ customType: "cloud-mode-setup", content: report, display: true }, { triggerTurn: false });

			if (ctx.mode === "tui") {
				const allOk = await runWizard(ctx, { configDirName: CONFIG_DIR_NAME, emitReport });
				reloadConfig(ctx);
				updateStatusLine(ctx);
				if (allOk) ctx.ui.notify("Cloud Mode is ready ✅", "info");
				return;
			}

			// Non-TUI: read-only doctor report.
			const { report, allOk } = await runDoctor({
				trusted: ctx.isProjectTrusted(),
				config,
				configError,
				configPath: `${CONFIG_DIR_NAME}/cloud-mode.json`,
			});
			emitReport(report);
			ctx.ui.notify(allOk ? "Cloud Mode is ready ✅" : "Cloud Mode setup incomplete — see report", allOk ? "info" : "warning");
		},
	});

	// ── Command: /cloud-mode-repo ──────────────────────────────────────────────
	pi.registerCommand("cloud-mode-repo", {
		description: "Select or create the GitHub repo that sub-agents work on",
		handler: async (_args, ctx) => {
			reloadConfig(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Repo picker requires interactive TUI mode.", "warning");
				return;
			}
			if (!ctx.isProjectTrusted()) {
				ctx.ui.notify("Project is not trusted; cannot persist repo selection.", "warning");
				return;
			}
			const owner = config?.githubOwner;
			if (!owner) {
				ctx.ui.notify(configError ?? "githubOwner not configured.", "error");
				return;
			}
			const repo = await pickRepo(ctx, owner);
			if (!repo) return;
			saveSelectedRepo(ctx.cwd, CONFIG_DIR_NAME, repo);
			reloadConfig(ctx);
			ctx.ui.notify(`Target repo: ${repo.nameWithOwner} (base: ${repo.defaultBranch})`, "info");
			updateStatusLine(ctx);
		},
	});

	// ── Command: /cloud-mode (live overlay panel) ───────────────────────────────
	pi.registerCommand("cloud-mode", {
		description: "Open the live cloud-agents overlay (watch/steer/stop, never leaves your session)",
		handler: async (_args, ctx) => {
			reloadConfig(ctx);
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The cloud-mode panel requires interactive TUI mode.", "warning");
				return;
			}
			if (registry.list().length === 0) {
				ctx.ui.notify("No cloud agents yet. Use the delegate_story tool to launch one.", "info");
				return;
			}
			await openPanel(ctx);
		},
	});

	// Open the live overlay and service its steer/stop actions in a loop, so those
	// actions can run and then re-open the panel on the same agent without ever
	// switching the user's pi session. Shared by /cloud-mode and /cloud-mode-test.
	async function openPanel(ctx: ExtensionCommandContext): Promise<void> {
		while (true) {
			const res = await ctx.ui.custom<PanelResult>(makePanel(registry, lastViewedSessionId), {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
			});
			if (!res || res.type === "close") break;

			lastViewedSessionId = res.sessionId;
			const agent = registry.get(res.sessionId);
			if (!agent) continue;

			if (res.type === "steer") {
				if (!config || configError) {
					ctx.ui.notify(configError ?? "Config not loaded.", "error");
					continue;
				}
				const text = await ctx.ui.input(
					`Message to '${agent.storyId}'`,
					registry.isTerminal(agent.status) ? "Re-prompt the finished agent…" : "Steer the running agent…",
				);
				if (text?.trim()) {
					const action = registry.isTerminal(agent.status) ? "prompt" : "steer";
					startStream(agent, { action, text, sinceSeq: agent.lastSeq ?? 0 }, ctx);
				}
				continue;
			}

			if (res.type === "stop") {
				await stopAgent(agent, ctx);
				continue;
			}
		}
	}

	// ── Command: /cloud-mode-test (local synthetic emitter, no network) ─────────
	// Verifies the local live-render pipeline end to end: a fake agent streams
	// status + thinking/tool/text events straight into the registry on a timer, so
	// you can confirm the widget and overlay panel re-render live. No AgentCore,
	// no worker, no config required — pure isolation test for "can I see updates?".
	pi.registerCommand("cloud-mode-test", {
		description: "Launch a local synthetic agent that streams fake thinking/tool events (render test, no network)",
		handler: async (_args, ctx) => {
			const storyId = `TEST-${Date.now().toString(36)}`;
			const sessionId = `cloudmode-test-${randomUUID()}${randomUUID().replace(/-/g, "")}`.slice(0, 90);
			const agent: CloudAgent = {
				sessionId,
				storyId,
				headline: `${storyId}: local render test`,
				description: "Synthetic test agent (no network).",
				status: "starting",
				startedAt: Date.now(),
				transcript: [],
			};
			registry.add(agent);
			lastViewedSessionId = sessionId;
			updateStatusLine(ctx);

			const controller = new AbortController();
			const key = `${sessionId}:${Date.now()}`;
			streams.set(key, controller);
			void runTestEmitter({
				registry,
				sessionId,
				signal: controller.signal,
				onChange: () => updateStatusLine(ctx),
			}).finally(() => streams.delete(key));

			if (ctx.mode === "tui") {
				await openPanel(ctx);
			} else {
				ctx.ui.notify(`Launched synthetic test agent '${storyId}'.`, "info");
			}
		},
	});

	// ── Command: /cloud-mode-demo (scripted 3-agent scenario for the demo video) ─
	// Same philosophy as /cloud-mode-test, but a full storyboard: three named
	// agents with realistic story-specific transcripts, staggered starts and
	// staggered PR completions. Real pipeline (registry → widget → overlay),
	// scripted source — no AWS, no network, no cost. `/cloud-mode-demo fast`
	// runs at 2× for rehearsal.
	pi.registerCommand("cloud-mode-demo", {
		description: "Launch the scripted 3-agent demo scenario (no network; for recording the demo video)",
		handler: async (args, ctx) => {
			reloadConfig(ctx);
			const speed = args?.trim() === "fast" ? 0.5 : 1;
			const stories = makeDemoStories(config?.repo?.nameWithOwner ?? "acme/example-service");
			for (const story of stories) {
				if (registry.hasStory(story.storyId)) {
					ctx.ui.notify(`Demo already running ('${story.storyId}' exists). /cloud-mode-clear first.`, "warning");
					return;
				}
			}
			for (const story of stories) {
				const sessionId = `cloudmode-demo-${randomUUID()}${randomUUID().replace(/-/g, "")}`.slice(0, 90);
				const controller = new AbortController();
				const key = `${sessionId}:${Date.now()}`;
				streams.set(key, controller);
				const launch = async () => {
					await new Promise((r) => setTimeout(r, story.startAfterMs * speed));
					if (controller.signal.aborted) return;
					registry.add({
						sessionId,
						storyId: story.storyId,
						headline: story.headline,
						description: story.description,
						status: "starting",
						startedAt: Date.now(),
						transcript: [],
					});
					lastViewedSessionId ??= sessionId;
					updateStatusLine(ctx);
					await runDemoScript(
						{ registry, sessionId, signal: controller.signal, onChange: () => updateStatusLine(ctx), speed },
						story.script,
					);
				};
				void launch().finally(() => streams.delete(key));
			}
			ctx.ui.notify("Demo scenario launched: 3 scripted agents (no network). alt+g to watch.", "info");
		},
	});

	// ── Command: /cloud-mode-stop ───────────────────────────────────────────────
	pi.registerCommand("cloud-mode-stop", {
		description: "Stop a running cloud agent",
		handler: async (_args, ctx) => {
			reloadConfig(ctx);
			if (!config || configError) {
				ctx.ui.notify(configError ?? "Config not loaded.", "error");
				return;
			}
			const running = registry.list().filter((a) => !registry.isTerminal(a.status));
			if (running.length === 0) {
				ctx.ui.notify("No running cloud agents.", "info");
				return;
			}
			const labels = running.map((a) => `${statusGlyph(a.status)} ${a.headline}`);
			const choice = await ctx.ui.select("Stop which agent?", labels);
			if (!choice) return;
			const agent = running[labels.indexOf(choice)];
			if (agent) await stopAgent(agent, ctx);
		},
	});

	// ── Command: /cloud-mode-clear (dismiss finished agents / hide the widget) ──
	pi.registerCommand("cloud-mode-clear", {
		description: "Remove finished (done/failed) agents from the dashboard; hides the widget once none remain",
		handler: async (_args, ctx) => {
			const removed = registry.clearTerminal();
			if (removed.length === 0) {
				ctx.ui.notify("No finished agents to clear.", "info");
				return;
			}
			// Make sure no background (poll) streams linger for the cleared agents.
			for (const id of removed) abortStreams(id);
			if (lastViewedSessionId && removed.includes(lastViewedSessionId)) lastViewedSessionId = undefined;
			updateStatusLine(ctx);
			ctx.ui.notify(`Cleared ${removed.length} finished agent(s).`, "info");
		},
	});

	async function stopAgent(agent: CloudAgent, ctx: ExtensionContext): Promise<void> {
		if (!config || configError) {
			ctx.ui.notify(configError ?? "Config not loaded.", "error");
			return;
		}
		try {
			await stopRuntimeSession({
				region: config.region,
				agentRuntimeArn: config.agentRuntimeArn,
				qualifier: config.qualifier,
				sessionId: agent.sessionId,
			});
			abortStreams(agent.sessionId);
			registry.patch(agent.sessionId, { status: "failed", errorMessage: "Stopped by user" });
			registry.appendTranscript(agent.sessionId, { kind: "note", text: "■ Stopped by user." });
			ctx.ui.notify(`Stopped agent '${agent.storyId}'.`, "info");
			updateStatusLine(ctx);
		} catch (e) {
			ctx.ui.notify(`Failed to stop agent: ${(e as Error).message}`, "error");
		}
	}

	// ── Shortcut ────────────────────────────────────────────────────────────────
	pi.registerShortcut("alt+g", {
		description: "Cloud Mode: open the live agents panel",
		handler: () => pi.sendUserMessage("/cloud-mode"),
	});

	// ── Lifecycle ───────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		reloadConfig(ctx);
		restoreAgents(ctx);
		// First-run nudge: point new users at the onboarding doctor instead of
		// letting them discover a broken config on their first delegate call.
		if (configError && ctx.hasUI) {
			ctx.ui.notify("Cloud Mode is not configured yet — run /cloud-mode-setup to get started (GitHub + AWS required).", "warning");
		}
		// Keep the live widget re-rendering as agents change for the lifetime of
		// this session (we never switch, so ctx stays valid — a benefit of the new
		// design). The widget component self-subscribes for per-event re-renders.
		updateStatusLine(ctx);
		installWidget(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		// Only tear down background streams on a genuine process quit or reload.
		if (event.reason === "quit" || event.reason === "reload") {
			for (const ctrl of streams.values()) ctrl.abort();
			streams.clear();
		}
	});

	function err(text: string) {
		return { content: [{ type: "text" as const, text }], isError: true, details: {} };
	}
}

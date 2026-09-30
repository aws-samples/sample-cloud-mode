// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Cloud Mode worker — Bedrock AgentCore Runtime contract wrapping pi.
 *
 * Serves the AgentCore container contract:
 *   - GET  /ping         → health check.
 *   - POST /invocations  → text/event-stream of agent events.
 *
 * Session model (one runtime-session-id == one delegated story == one pi
 * AgentSession):
 *   - First invoke ({action:"start", ...}): mint GitHub App token → clone +
 *     worktree → start a pi AgentSession on the story prompt → stream every pi
 *     event out as SSE. On agent end: commit / push / open PR → emit a final
 *     `cloud_pr` + `cloud_done` event.
 *   - Same-session invokes ({action:"steer"|"prompt"|"followUp", text}):
 *     deliver the input to the live AgentSession and join its event stream so
 *     the caller renders the merged, live events (real interaction).
 *   - Read-only re-attach ({action:"attach", sinceSeq}): replay every buffered
 *     event after `sinceSeq` and end immediately — a stateless poll that lets a
 *     client (re)join a live session without injecting input, resuming gap-free
 *     from the last seq it rendered.
 *
 * The AgentCore data plane holds a single streaming invoke open for the life of
 * the response, so we stream incrementally (SSE) rather than buffering.
 */

import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	cleanupWorktree,
	commitAndPush,
	configureGitAuth,
	ensurePrMerged,
	finalizeAndOpenPr,
	finalizeDirectMerge,
	mintInstallationToken,
	prepareWorktree,
	startCheckpointPusher,
	waitForChecks,
} from "./git.mjs";
import { resolveGitHubAppCreds } from "./secrets.mjs";
import { makeLlmResolver } from "./llm-resolver.mjs";
import { makeLlmRepair } from "./llm-repair.mjs";
import { purgeStaticCredentialEnvVars, startAgentCredentialBroker } from "./aws-identity.mjs";
import { describeSandbox, initSandbox, untrustedBashSpawnHook } from "./sandbox.mjs";
import { archiveTranscript, transcriptArchivingEnabled } from "./transcript-archive.mjs";
import { Hub } from "./hub.mjs";
import { admitAction, admitStart, MAX_ACTIVE_SESSIONS } from "./session-guard.mjs";
import { confinedFileOperations, confinedFindOperations } from "./file-confinement.mjs";
import { TOKEN_DIR } from "./git-auth.mjs";
import { redactingLogger } from "./redact.mjs";
import { agentIsolationRequested, startAgentProcess } from "./agent-host.mjs";
import { startModelProxy } from "./model-proxy.mjs";
import {
	clearUngated,
	isUngated,
	markUngated,
	ungatedSummary,
	UNGATED_BRANCH_PROTECTION,
	UNGATED_VALIDATION_SKIPPED,
} from "./gating.mjs";

const PORT = Number(process.env.PORT ?? 8080);

// ── Redacted stdout ────────────────────────────────────
// Everything this process prints reaches CloudWatch, where a different set of
// principals can read it than can read the repository. Wrapping the console here
// — once, at the process level — means no individual log call site has to
// remember, including log lines added later and those inside pi itself.
console.log = redactingLogger(console.log.bind(console));
console.warn = redactingLogger(console.warn.bind(console));
console.error = redactingLogger(console.error.bind(console));
// Files created by the orchestrator (pi's edit/write tools, git checkout) must
// stay writable for the unprivileged user that runs the repo's own scripts —
// otherwise a `prettier --write` or codegen step in the validation gate fails on
// permissions. Combined with the setgid worktree from sandbox.mjs this keeps a
// single shared group as the only coupling between the two users. The token
// store and its directory set their modes explicitly (git.mjs), so 002 does not
// widen them.
process.umask(0o002);
const SID_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
const PROVIDER = process.env.PI_PROVIDER ?? "amazon-bedrock";
const MODEL_ID = process.env.PI_MODEL ?? "global.anthropic.claude-opus-5";
// CI-gate config: after opening the PR, wait for GitHub checks and let the agent
// fix red CI up to N times before teardown (0 disables the gate entirely).
const CI_MAX_FIX_ATTEMPTS = Number(process.env.CLOUD_MODE_CI_MAX_FIX_ATTEMPTS ?? 2);
// How often the agent's work-in-progress is committed and pushed to the feature
// branch while it is still running. This is the worker's liveness signal: an
// outside observer (coordinator) sees the branch move, and a run that dies
// mid-flight leaves its partial work on GitHub instead of in a dead container.
// 0 disables checkpointing (previous behaviour: one push at the very end).
const CHECKPOINT_MS = Number(process.env.CLOUD_MODE_CHECKPOINT_MS ?? 3 * 60_000);
const CI_WAIT_TIMEOUT_MS = Number(process.env.CLOUD_MODE_CI_WAIT_TIMEOUT_MS ?? 15 * 60_000);
// Once CI is green, land the PR ourselves (in addition to GitHub auto-merge) so
// delivery does not depend on a repo setting or a human clicking merge. A base
// branch that moved in the meantime is rebased and re-gated up to N times.
const MERGE_ON_GREEN = (process.env.CLOUD_MODE_MERGE_ON_GREEN ?? "1") !== "0";
const MERGE_MAX_REBASE_ROUNDS = Number(process.env.CLOUD_MODE_MERGE_MAX_REBASE_ROUNDS ?? 3);

/** @typedef {(event: object) => void} Listener */

/**
 * Runtime isolation setup. Two boundaries, both established once per container:
 *
 *   1. CREDENTIALS — the runtime role's credentials are never exported into
 *      `process.env`. A loopback broker (aws-identity.mjs) vends a scoped,
 *      Bedrock-only agent role for the model traffic and satisfies pi's provider
 *      gate with `AWS_CONTAINER_CREDENTIALS_FULL_URI`; Secrets Manager keeps
 *      using the orchestrator identity explicitly.
 *   2. EXECUTION — every untrusted command (the agent's shell, the repository's
 *      build/test scripts) runs through sandbox.mjs: a separate unprivileged OS
 *      user where the platform allows it, always with an allow-listed
 *      environment.
 *
 * Degradations are reported, not hidden: `cloud_isolation` carries the effective
 * posture into the operator's overlay, and the CLOUD_MODE_REQUIRE_* switches
 * turn either degradation into a hard failure.
 */
let isolationPromise;
function ensureIsolation() {
	isolationPromise ??= (async () => {
		purgeStaticCredentialEnvVars({ log: (m) => console.log(m) });
		const [broker, sandbox] = await Promise.all([
			startAgentCredentialBroker({ log: (m) => console.log(m) }),
			initSandbox({ log: (m) => console.log(m) }),
		]);
		return {
			credentialScope: broker.scope,
			credentialRoleArn: broker.roleArn,
			credentials: broker.describe,
			sandboxMode: sandbox.mode,
			sandbox: describeSandbox(sandbox),
			// The out-of-process agent holds no credential: the loopback model proxy
			// re-signs its requests with exactly this (Bedrock-only) identity.
			agentCredentials: broker.credentials,
		};
	})();
	return isolationPromise;
}

/** @type {Map<string, { hub: Hub, session?: import("@earendil-works/pi-coding-agent").AgentSession, done: boolean, meta: object }>} */
const sessions = new Map();

let sharedModel;
let sharedModelRuntime;
/**
 * Resolve the configured Bedrock model through pi's async ModelRuntime facade
 * (pi >= 0.80.8: `AuthStorage`/`ModelRegistry.create()` are gone).
 */
async function resolveModel() {
	if (sharedModel !== undefined) return sharedModel;
	sharedModelRuntime ??= await ModelRuntime.create();
	const model = sharedModelRuntime.getModel(PROVIDER, MODEL_ID);
	if (!model) {
		throw new Error(`Model not found in registry: ${PROVIDER}/${MODEL_ID}`);
	}
	sharedModel = model;
	return sharedModel;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

function writeSse(res, event) {
	// `writableEnded` guards against writing after the response is closed (e.g. a
	// trailing history event replayed right after a `cloud_done` ended the stream).
	if (res.writableEnded) return;
	try {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	} catch {
		/* response already closed */
	}
}

/**
 * Kick off a brand-new agent for {action:"start"}. Runs entirely in the
 * background against the hub; the HTTP response just subscribes to the hub.
 */
async function startAgent(sid, payload, entry) {
	const { hub, meta } = entry;
	const {
		storyId,
		userStory,
		repoUrl,
		repoNwo,
		baseBranch = "main",
		deliveryMode = "pull-request",
		// Attribution: who delegated this story. Self-
		// reported by the client and therefore NOT an authorization input — it exists
		// so a commit or PR can be correlated with a CloudTrail InvokeAgentRuntime
		// event in one hop instead of by guesswork.
		delegatedBy,
		/**
		 * The delegating client tells us when it launched without an enforced
		 * machine gate — `requireBranchProtection: false`, or protection it could not
		 * verify. Self-reported like `delegatedBy`: it only makes the
		 * delivery honest, it is never an authorization input.
		 */
		branchProtectionWaived,
	} = payload;
	Object.assign(meta, {
		storyId,
		repoNwo,
		baseBranch,
		deliveryMode,
		startedAt: Date.now(),
		sessionId: sid,
		delegatedBy: typeof delegatedBy === "string" ? delegatedBy.slice(0, 256) : undefined,
	});
	console.log(
		`[cloud-mode] start story=${storyId} repo=${repoNwo} delivery=${deliveryMode} ` +
			`session=${sid} delegatedBy=${meta.delegatedBy ?? "unknown"}`,
	);

	// ── Escape hatches: record them now, report them everywhere ──
	// Both are known before the first commit, so the attribution trailer, the PR
	// body and the operator's stream all carry the same truth.
	if (/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_ALLOW_UNVALIDATED ?? "")) {
		markUngated(storyId, UNGATED_VALIDATION_SKIPPED, "CLOUD_MODE_ALLOW_UNVALIDATED=1 on the runtime");
	}
	if (branchProtectionWaived === true || typeof branchProtectionWaived === "string") {
		markUngated(
			storyId,
			UNGATED_BRANCH_PROTECTION,
			typeof branchProtectionWaived === "string" ? branchProtectionWaived.slice(0, 200) : "reported by the client",
		);
	}
	if (isUngated(storyId)) {
		const summary = ungatedSummary(storyId);
		console.warn(`[cloud-mode] UNGATED DELIVERY story=${storyId}: ${summary}`);
		hub.emit({ type: "cloud_warning", code: "ungated_delivery", storyId, detail: summary });
	}

	const root = mkdtempSync(join(tmpdir(), "cloud-mode-"));
	let worktreeInfo;
	let modelProxy;
	try {
		// Establish the credential + execution boundaries before anything untrusted
		// exists, and tell the operator which posture this run actually has.
		const isolation = await ensureIsolation();
		Object.assign(meta, {
			credentialScope: isolation.credentialScope,
			sandboxMode: isolation.sandboxMode,
		});
		hub.emit({ type: "cloud_isolation", storyId, ...isolation });

		hub.emit({ type: "cloud_status", status: "authenticating", storyId });
		const creds = await resolveGitHubAppCreds();
		const token = await mintInstallationToken(creds);
		await configureGitAuth(token);

		hub.emit({ type: "cloud_status", status: "cloning", repoNwo, baseBranch });
		worktreeInfo = await prepareWorktree({ repoUrl, repoNwo, baseBranch, storyId, root });
		meta.branch = worktreeInfo.branch;

		const model = await resolveModel();
		const sessionManager = SessionManager.inMemory(worktreeInfo.worktree);
		// Path-confined file tools: pi's read/write/edit/
		// ls/grep/find run in *this* process, so without a guard an injected agent
		// could read `/proc/self/environ` or rewrite the clone's `.git` without ever
		// asking for a shell. Registering same-named custom tools overrides the
		// built-ins, exactly as the sandboxed bash tool below does.
		const confined = confinedFileOperations(worktreeInfo.worktree, { extraDenied: [TOKEN_DIR] });

		// ── Out-of-process agent ────────────────────
		// When enabled, the AgentSession runs in its own process as the
		// unprivileged user with NO credential in reach; model traffic is re-signed
		// by a loopback proxy here in the orchestrator. See
		// docs/agent-isolation.md. Default off until verified on a deployed
		// runtime — a mistake here breaks every delegation, whereas the in-process
		// path is already confined by increment 1.
		if (agentIsolationRequested()) {
			const isolation = await ensureIsolation();
			modelProxy = await startModelProxy({
				pinnedModel: MODEL_ID,
				region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
				credentials: isolation.agentCredentials,
				log: (m) => console.log(m),
			});
			const agent = await startAgentProcess({
				cwd: worktreeInfo.worktree,
				model: MODEL_ID,
				provider: PROVIDER,
				proxy: { url: modelProxy.url, token: modelProxy.token },
				log: (m) => console.log(m),
			});
			entry.session = agent;
			agent.subscribe((event) => hub.emit(event));
			hub.emit({
				type: "cloud_isolation",
				agentProcess: agent.mode === "separate-uid" ? "separate-uid" : "same-uid",
				agentUid: agent.uid,
				sandboxMode: agent.mode,
			});
		}
		const { session } = entry.session
			? { session: entry.session }
			: await createAgentSession({
			model,
			cwd: worktreeInfo.worktree,
			sessionManager,
			// Replace the built-in bash tool with one whose spawns go through the
			// untrusted-execution boundary (separate OS user + allow-listed env).
			// A custom tool with the same name overrides the built-in one.
			customTools: [
				createBashToolDefinition(worktreeInfo.worktree, {
					spawnHook: untrustedBashSpawnHook(),
					exposeSessionEnvironment: false,
				}),
				createReadToolDefinition(worktreeInfo.worktree, { operations: confined.read }),
				createWriteToolDefinition(worktreeInfo.worktree, { operations: confined.write }),
				createEditToolDefinition(worktreeInfo.worktree, { operations: confined.edit }),
				createLsToolDefinition(worktreeInfo.worktree, { operations: confined.ls }),
				createGrepToolDefinition(worktreeInfo.worktree, { operations: confined.grep }),
				createFindToolDefinition(worktreeInfo.worktree, {
					operations: confinedFindOperations(worktreeInfo.worktree, { extraDenied: [TOKEN_DIR] }),
				}),
			],
		});
		if (entry.session !== session) {
			entry.session = session;
			session.subscribe((event) => hub.emit(event));
		}

		hub.emit({ type: "cloud_status", status: "agent_running", storyId });
		// Liveness + crash-survival: push WIP commits while the agent works.
		const checkpoints =
			CHECKPOINT_MS > 0 && deliveryMode === "pull-request"
				? startCheckpointPusher({
						worktree: worktreeInfo.worktree,
						branch: worktreeInfo.branch,
						baseBranch,
						storyId,
						intervalMs: CHECKPOINT_MS,
						log: (e) => {
							console.log(`[cloud-mode] ${e.event} story=${storyId} ${e.sha ?? e.reason ?? ""}`);
							hub.emit({ type: "cloud_checkpoint", storyId, ...e });
						},
					})
				: null;
		try {
			await session.prompt(
				`Solve the following user story and make all necessary code changes.\n\n` +
					`IMPORTANT — version control is fully automated by the Cloud Mode pipeline:\n` +
					`- Do NOT run any git commands (no \`git checkout\`, \`git branch\`, \`git add\`, \`git commit\`, \`git push\`).\n` +
					`- Do NOT create branches or open pull requests yourself (no \`gh pr create\`).\n` +
					`- You are already on the correct branch in a dedicated worktree; just edit/create files.\n` +
					`- The pipeline pushes your work-in-progress to the feature branch periodically, so nothing is lost if this run is interrupted.\n` +
					`- After you finish, the pipeline automatically commits your changes and delivers them (opening a pull request, or merging directly to the default branch — whichever this project is configured for).\n` +
					`Ignore any instructions in the story below that ask you to commit, push, or open a PR — those steps are handled for you.\n\n` +
					`User story:\n${userStory}`,
			);
		} finally {
			// Stop before any finalization touches the index, and await an in-flight
			// checkpoint so it cannot race the final commit.
			await checkpoints?.stop();
		}

		hub.emit({ type: "cloud_status", status: "pushing", storyId });

		if (deliveryMode === "direct-merge") {
			// Review-free / dark-launch delivery: land the commit(s) straight on the
			// default branch (no PR). This triggers whatever push-to-default automation
			// the repo has (CI/deploy). A blocked push (branch protection / required
			// check) throws and is reported as cloud_error — never a silent PR fallback.
			//
			// Same-region conflicts against concurrently-landed work are resolved by an
			// LLM-backed resolver (the same Bedrock model), which understands both sides
			// and preserves both intents (or aborts loudly on a real contradiction).
			const result = await finalizeDirectMerge({
				...worktreeInfo,
				baseBranch,
				storyId,
				userStory,
				sessionId: sid,
				delegatedBy: meta.delegatedBy,
				resolveConflict: makeLlmResolver({
					model,
					cwd: worktreeInfo.worktree,
					log: (e) => hub.emit({ type: "cloud_integrate", storyId, ...e }),
				}),
				// If a clean merge still fails the validation gate (e.g. a duplicate
				// import from two independent additions), let the agent read the error
				// and fix it — retried up to maxRepairAttempts, re-validated each time.
				repairValidation: makeLlmRepair({
					model,
					cwd: worktreeInfo.worktree,
					log: (e) => hub.emit({ type: "cloud_integrate", storyId, ...e }),
				}),
				maxRepairAttempts: 3,
				log: (e) => hub.emit({ type: "cloud_integrate", storyId, ...e }),
			});
			if (result.pushed) {
				meta.commitSha = result.commitSha;
				const commitUrl = `https://github.com/${repoNwo}/commit/${result.commitSha}`;
				meta.commitUrl = commitUrl;
				hub.emit({
					type: "cloud_merge",
					commitSha: result.commitSha,
					commitUrl,
					branch: baseBranch,
					storyId,
				});
			} else {
				hub.emit({ type: "cloud_status", status: "no_changes", storyId });
			}
			hub.emit({ type: "cloud_done", exitCode: 0 });
			return;
		}

		const result = await finalizeAndOpenPr({
			...worktreeInfo,
			baseBranch,
			storyId,
			userStory,
			sessionId: sid,
			delegatedBy: meta.delegatedBy,
		});
		if (result.prUrl) {
			meta.prUrl = result.prUrl;
			hub.emit({
				type: "cloud_pr",
				url: result.prUrl,
				branch: worktreeInfo.branch,
				autoMerge: result.autoMerge === true,
			});
			if (result.autoMerge === false && result.autoMergeError) {
				// Not fatal: we still merge explicitly once CI is green (below).
				hub.emit({
					type: "cloud_status",
					status: "auto_merge_unavailable",
					storyId,
					detail: result.autoMergeError,
				});
			}
		} else if (!result.pushed) {
			hub.emit({ type: "cloud_status", status: "no_changes", storyId });
		}

		// CI gate + landing: while the session + worktree are still alive, wait for the
		// PR's checks, let the agent fix red CI in place, and then land the PR. This is
		// the only viable window — the `finally` below disposes the session and deletes
		// the worktree, after which fixes would require a new delegation.
		//
		// Why merge here at all when auto-merge is armed? Auto-merge depends on a repo
		// setting and on protection being configured; merging explicitly makes delivery
		// independent of both, and gives us a bounded rebase+re-gate loop when another
		// agent lands first (`strict` protection then marks this PR BEHIND).
		if (result.pushed && CI_MAX_FIX_ATTEMPTS > 0) {
			let fixAttempts = 0;
			let rebaseRounds = 0;
			landing: for (;;) {
				hub.emit({ type: "cloud_status", status: "ci_waiting", attempt: fixAttempts + 1, storyId });
				const ci = await waitForChecks({
					worktree: worktreeInfo.worktree,
					branch: worktreeInfo.branch,
					timeoutMs: CI_WAIT_TIMEOUT_MS,
				});

				if (ci.state === "timeout") {
					hub.emit({ type: "cloud_status", status: "ci_timeout", storyId });
					break;
				}

				if (ci.state === "fail") {
					fixAttempts += 1;
					if (fixAttempts >= CI_MAX_FIX_ATTEMPTS) {
						hub.emit({ type: "cloud_ci_failed", attempts: fixAttempts, logs: ci.failingLogs });
						break;
					}
					hub.emit({ type: "cloud_status", status: "ci_fixing", attempt: fixAttempts, storyId });
					await session.prompt(
						`The pull request's CI checks failed. Fix the code so all checks pass.\n` +
							`Do NOT run any git or gh commands — the pipeline will commit and push your fixes.\n\n` +
							`Failing CI output:\n${ci.failingLogs}`,
					);
					await commitAndPush({
						worktree: worktreeInfo.worktree,
						branch: worktreeInfo.branch,
						baseBranch,
						title: `fix(${storyId}): address failing CI (attempt ${fixAttempts})`,
					});
					continue;
				}

				// ci.state === "pass" | "none"
				hub.emit({ type: "cloud_status", status: "ci_passed", storyId });
				if (!MERGE_ON_GREEN) break;

				hub.emit({ type: "cloud_status", status: "merging", storyId });
				const landed = await ensurePrMerged({
					worktree: worktreeInfo.worktree,
					branch: worktreeInfo.branch,
					log: (e) => hub.emit({ type: "cloud_integrate", storyId, ...e }),
				});

				if (landed.merged) {
					hub.emit({
						type: "cloud_merge",
						branch: baseBranch,
						prUrl: result.prUrl,
						storyId,
					});
					break landing;
				}

				if (landed.updatedBranch && rebaseRounds < MERGE_MAX_REBASE_ROUNDS) {
					// Another agent landed first; the PR was rebased onto the new base.
					// Re-run the CI gate against that merge result, then try again.
					rebaseRounds += 1;
					hub.emit({ type: "cloud_status", status: "rebased_on_base", attempt: rebaseRounds, storyId });
					continue;
				}

				hub.emit({
					type: "cloud_status",
					status: "merge_blocked",
					storyId,
					detail: landed.reason ?? `merge state: ${landed.state}`,
				});
				break;
			}
		}

		hub.emit({ type: "cloud_done", exitCode: 0 });
	} catch (err) {
		hub.emit({ type: "cloud_error", message: err?.message ?? String(err) });
		hub.emit({ type: "cloud_done", exitCode: 1 });
	} finally {
		entry.done = true;
		try {
			// Out-of-process agents are shut down and WAITED for; in-process ones are
			// disposed. Either way nothing driven by the model is still running when
			// the transcript is archived.
			if (typeof entry.session?.shutdown === "function") await entry.session.shutdown();
			else entry.session?.dispose?.();
		} catch {
			/* ignore */
		}
		try {
			await modelProxy?.close();
		} catch {
			/* ignore */
		}
		// Durable forensics before the microVM (and this history) disappears.
		if (transcriptArchivingEnabled()) {
			const result = await archiveTranscript({
				sessionId: sid,
				meta: { ...meta, finishedAt: Date.now() },
				events: hub.history,
				log: (m) => console.log(m),
			});
			if (result.archived) hub.emit({ type: "cloud_transcript", storyId, uri: result.uri });
		}
		if (worktreeInfo) await cleanupWorktree(worktreeInfo);
		hub.close();
	}
}

/** Deliver interactive input to a live agent session. */
async function deliverInput(entry, action, text) {
	const session = entry.session;
	if (!session) throw new Error("Session is not ready for input yet");
	// The process-backed agent exposes prompt/interrupt only: steering a separate
	// process is a queued prompt, which is what steer/followUp mean to the
	// operator anyway.
	if (action === "steer" && typeof session.steer === "function") await session.steer(text);
	else if (action === "followUp" && typeof session.followUp === "function") await session.followUp(text);
	else await session.prompt(text);
}

async function handleInvocation(req, res) {
	const sid = req.headers[SID_HEADER];
	if (typeof sid !== "string" || sid.length < 33) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: `Missing or too-short ${SID_HEADER} (need >= 33 chars)` }));
		return;
	}

	let payload = {};
	try {
		const raw = await readBody(req);
		payload = raw ? JSON.parse(raw) : {};
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Invalid JSON payload" }));
		return;
	}

	const action = payload.action ?? "start";
	const sinceSeq = Number(payload.sinceSeq ?? 0);

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		[SID_HEADER]: sid,
	});

	let entry = sessions.get(sid);

	if (action === "attach") {
		// Read-only poll: replay everything after `sinceSeq`, then end immediately.
		// Watching is a series of short stateless polls rather than one long-lived
		// stream, so idle resets / drops become non-events — the next poll resumes
		// from the client's last seen seq. `fatal` tells the client to stop polling.
		if (!entry) {
			writeSse(res, { type: "cloud_error", message: "Session is no longer live", fatal: true });
			res.end();
			return;
		}
		const owner = admitAction({ entry, payload });
		if (!owner.ok) {
			writeSse(res, { type: "cloud_error", message: owner.message, code: owner.code, fatal: true });
			res.end();
			return;
		}
		entry.hub.replaySince((event) => writeSse(res, event), sinceSeq);
		res.end();
		return;
	}

	if (action === "start") {
		if (entry) {
			writeSse(res, { type: "cloud_error", message: `Session ${sid} already started` });
			res.end();
			return;
		}
		// Admission control (concurrency cap, owner binding) lives in
		// session-guard.mjs so it is unit-testable and enforced in ONE place.
		const admit = admitStart({ sessions, payload });
		if (!admit.ok) {
			writeSse(res, { type: "cloud_error", fatal: true, code: admit.code, message: admit.message });
			writeSse(res, { type: "cloud_done", exitCode: 1 });
			res.end();
			console.log(`[cloud-mode] rejected start ${sid}: ${admit.code} (active=${sessions.size}, max=${MAX_ACTIVE_SESSIONS})`);
			return;
		}
		const ownerToken = typeof payload.ownerToken === "string" ? payload.ownerToken : undefined;
		entry = { hub: new Hub(), done: false, meta: {}, ownerToken };
		sessions.set(sid, entry);
		// Fire the agent in the background; the response tracks the hub.
		void startAgent(sid, payload, entry);
	} else {
		if (!entry) {
			writeSse(res, { type: "cloud_error", message: `Unknown session ${sid}; send action:"start" first` });
			res.end();
			return;
		}
		const owner = admitAction({ entry, payload });
		if (!owner.ok) {
			writeSse(res, { type: "cloud_error", message: owner.message, code: owner.code, fatal: true });
			res.end();
			console.log(`[cloud-mode] rejected ${action} on ${sid}: ${owner.code}`);
			return;
		}
		try {
			await deliverInput(entry, action, payload.text ?? "");
		} catch (err) {
			writeSse(res, { type: "cloud_error", message: err?.message ?? String(err) });
		}
	}

	// Keepalive comment pings prevent idle-connection resets during quiet phases
	// (agent running tests, long model calls). `parseSseJson` ignores comments.
	const ping = setInterval(() => {
		try {
			res.write(": ping\n\n");
		} catch {
			/* response already closed */
		}
	}, 15000);

	// Stream hub events to this response until the agent finishes. `unsubscribe`
	// is declared with `let` + a no-op default because Hub.subscribe() replays
	// buffered history synchronously *before* it returns: if that history already
	// contains `cloud_done` (subscribing to an already-finished session), the
	// listener fires during subscribe() and calls unsubscribe(). With `const` that
	// hits the temporal dead zone (ReferenceError) and crashes the worker.
	let unsubscribe = () => {};
	unsubscribe = entry.hub.subscribe((event) => {
		writeSse(res, event);
		if (event.type === "cloud_done") {
			unsubscribe();
			clearInterval(ping);
			res.end();
		}
	}, sinceSeq);

	const cleanup = () => {
		clearInterval(ping);
		unsubscribe();
	};
	req.on("close", cleanup);
	res.on("close", cleanup);
}

const server = createServer((req, res) => {
	if (req.method === "GET" && req.url === "/ping") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ status: "Healthy" }));
		return;
	}
	if (req.method === "POST" && req.url === "/invocations") {
		void handleInvocation(req, res);
		return;
	}
	res.writeHead(404, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
	// eslint-disable-next-line no-console
	console.log(`[cloud-mode] worker listening on :${PORT} (provider=${PROVIDER}, model=${MODEL_ID})`);
	// Establish (and report) the credential + execution boundaries at boot rather
	// than on the first story, so a misconfigured runtime is visible in the logs
	// immediately. Errors here are fatal only when the operator demanded the
	// strong posture (CLOUD_MODE_REQUIRE_SCOPED_CREDS / REQUIRE_UID_SANDBOX).
	void ensureIsolation().catch((err) => {
		console.error(`[cloud-mode] isolation setup failed: ${err?.message ?? err}`);
		process.exitCode = 1;
		server.close();
	});
});

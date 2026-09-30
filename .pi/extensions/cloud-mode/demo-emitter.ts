// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Demo scenario — three synthetic agents with realistic, story-specific
 * transcripts, staggered starts and staggered completions.
 *
 * Built for recording the demo video: everything on screen (widget strip,
 * overlay panel, status line) is the REAL extension pipeline — registry,
 * pub/sub, live re-render — only the event *source* is scripted instead of an
 * AgentCore SSE stream. No network, no AWS, no cost, infinite retakes.
 *
 * Pacing is tuned for the storyboard: all three agents are visibly mid-work
 * between ~15s and ~50s (the "cycle through agents" shot), then finish one by
 * one with a PR link, so the closing shot shows glyphs flipping to ✓.
 */

import type { AgentRegistry, AgentStatus, TranscriptEntry } from "./registry.ts";

// ── Script model ─────────────────────────────────────────────────────────────

type Step =
	| { kind: "pause"; ms: number }
	| { kind: "status"; status: AgentStatus }
	| { kind: "line"; entryKind: TranscriptEntry["kind"]; text: string }
	| { kind: "stream"; entryKind: TranscriptEntry["kind"]; text: string }
	| { kind: "pr"; url: string; branch: string };

export interface DemoStory {
	storyId: string;
	headline: string;
	description: string;
	/** Delay before the agent appears (staggers the widget filling up). */
	startAfterMs: number;
	script: Step[];
}

// ── Shorthand builders ───────────────────────────────────────────────────────

const pause = (ms: number): Step => ({ kind: "pause", ms });
const status = (s: AgentStatus): Step => ({ kind: "status", status: s });
const line = (entryKind: TranscriptEntry["kind"], text: string): Step => ({ kind: "line", entryKind, text });
const stream = (entryKind: TranscriptEntry["kind"], text: string): Step => ({ kind: "stream", entryKind, text });
const pr = (url: string, branch: string): Step => ({ kind: "pr", url, branch });

/** The boilerplate every real run starts with: auth → clone → running. */
function bootSteps(repoNwo: string, userStory: string): Step[] {
	return [
		status("authenticating"),
		line("status", "▸ Minting GitHub App installation token…"),
		pause(900),
		status("cloning"),
		line("status", `▸ Cloning ${repoNwo} → git worktree…`),
		pause(1400),
		status("running"),
		line("user", userStory),
		pause(600),
	];
}

// ── The three stories ────────────────────────────────────────────────────────

/** Build the scripted stories against the actually-selected target repo. */
export function makeDemoStories(repoNwo: string): DemoStory[] {
	const prUrl = (n: number) => `https://github.com/${repoNwo}/pull/${n}`;
	return [
	{
		storyId: "STORY-101",
		headline: "STORY-101: Add a /healthz endpoint",
		description: "Add a GET /healthz endpoint returning 200 with a JSON status body, plus a test.",
		startAfterMs: 0,
		script: [
			...bootSteps(repoNwo, "Add a GET /healthz endpoint returning 200 with a JSON status body, plus a test."),
			stream(
				"thinking",
				"Let me look at how the server is structured. I need to find the request handler, add a GET /healthz route that returns 200 with a small JSON body, and keep it dependency-free.",
			),
			line("tool", "⚙ read(path=src/server.mjs)"),
			pause(1100),
			line("toolResult", "↳ read\nconst server = createServer((req, res) => {\n  if (req.url === '/users') return handleUsers(req, res);\n  res.writeHead(404); res.end();\n})"),
			stream(
				"thinking",
				"There is a single createServer handler with a 404 fallback. I will branch on req.url === '/healthz' before the fallback and return {\"status\":\"ok\"} with a 200. Then a supertest-style test next to the existing ones.",
			),
			line("tool", "⚙ edit(path=src/server.mjs)"),
			pause(1300),
			line("toolResult", "↳ edit\nAdded /healthz route before the 404 fallback."),
			pause(800),
			line("tool", "⚙ write(path=test/healthz.test.mjs)"),
			pause(1200),
			line("toolResult", "↳ write\nCreated test: GET /healthz → 200 {\"status\":\"ok\"}."),
			line("tool", "⚙ bash(command=npm test)"),
			pause(2600),
			line("toolResult", "↳ bash\n✓ users API (4 tests)\n✓ healthz returns 200 (1 test)\n5 passing"),
			stream(
				"assistant",
				"Done — added a GET /healthz endpoint returning {\"status\":\"ok\"} and a test covering it. All 5 tests pass. Committing and opening the pull request now.",
			),
			status("pushing"),
			line("status", "▸ Committing on cloud/story-101 → pushing → opening PR…"),
			pause(2200),
			pr(prUrl(41), "cloud/story-101"),
			status("done"),
		],
	},
	{
		storyId: "STORY-102",
		headline: "STORY-102: Paginate GET /users",
		description: "Add limit/offset pagination to GET /users with sane defaults and an X-Total-Count header.",
		startAfterMs: 2800,
		script: [
			...bootSteps(repoNwo, "Add limit/offset pagination to GET /users with sane defaults and an X-Total-Count header."),
			stream(
				"thinking",
				"First I need to understand the current handler. The story asks for limit/offset with sane defaults — I'll cap limit to avoid unbounded queries, default to limit=20 offset=0, and expose the total via X-Total-Count.",
			),
			line("tool", "⚙ read(path=src/routes/users.mjs)"),
			pause(1200),
			line("toolResult", "↳ read\nexport async function handleUsers(req, res) {\n  const users = await db.allUsers();\n  res.end(JSON.stringify(users));\n}"),
			stream(
				"thinking",
				"The handler returns the full table — that explains the story. I will parse limit and offset from the query string, clamp limit to 1..100, slice at the db layer, and set X-Total-Count before serializing.",
			),
			line("tool", "⚙ edit(path=src/routes/users.mjs)"),
			pause(1500),
			line("toolResult", "↳ edit\nAdded query parsing, clamping (limit 1..100, default 20) and X-Total-Count."),
			pause(700),
			line("tool", "⚙ edit(path=src/db.mjs)"),
			pause(1300),
			line("toolResult", "↳ edit\nallUsers({ limit, offset }) now pushes LIMIT/OFFSET into the query."),
			line("tool", "⚙ write(path=test/users-pagination.test.mjs)"),
			pause(1400),
			line("toolResult", "↳ write\n3 cases: defaults, explicit limit/offset, limit clamped at 100."),
			line("tool", "⚙ bash(command=npm test)"),
			pause(2800),
			line("toolResult", "↳ bash\n✓ users API (4 tests)\n✓ pagination (3 tests)\n8 passing"),
			stream(
				"assistant",
				"Pagination is in: GET /users now accepts limit and offset (default 20/0, limit clamped to 100) and returns X-Total-Count. Existing behaviour is unchanged for callers without query params. Opening the PR.",
			),
			status("pushing"),
			line("status", "▸ Committing on cloud/story-102 → pushing → opening PR…"),
			pause(2200),
			pr(prUrl(42), "cloud/story-102"),
			status("done"),
		],
	},
	{
		storyId: "STORY-103",
		headline: "STORY-103: Fix flaky retry test",
		description: "test/retry.test.mjs fails intermittently in CI ('expected 3 attempts, got 2'). Find the race and make it deterministic.",
		startAfterMs: 5600,
		script: [
			...bootSteps(
				repoNwo,
				"test/retry.test.mjs fails intermittently in CI ('expected 3 attempts, got 2'). Find the race and make it deterministic.",
			),
			line("tool", "⚙ bash(command=for i in 1 2 3 4 5; do npm test -- retry; done)"),
			pause(3200),
			line("toolResult", "↳ bash\nrun 1: ✓ 3 passing\nrun 2: ✗ expected 3 attempts, got 2\nrun 3: ✓ 3 passing\nrun 4: ✓ 3 passing\nrun 5: ✗ expected 3 attempts, got 2"),
			stream(
				"thinking",
				"Reproduced — roughly 2 in 5 runs fail. 'Got 2' suggests the third retry hasn't fired when the assertion runs, which smells like a real-timer race: the test probably waits a fixed 250ms while backoff is 100ms × attempt, so attempt three lands at ~300ms.",
			),
			line("tool", "⚙ read(path=test/retry.test.mjs)"),
			pause(1200),
			line("toolResult", "↳ read\nawait sleep(250);\nassert.equal(attempts, 3); // flaky: backoff schedule is 100ms, 200ms, 300ms"),
			stream(
				"thinking",
				"Confirmed. Instead of bumping the sleep — which just moves the race — I'll switch the test to fake timers and advance the clock deterministically past each backoff step. No production code change needed.",
			),
			line("tool", "⚙ edit(path=test/retry.test.mjs)"),
			pause(1600),
			line("toolResult", "↳ edit\nReplaced sleep(250) with mock timers; clock advances 100/200/300ms explicitly."),
			line("tool", "⚙ bash(command=for i in $(seq 20); do npm test -- retry || break; done)"),
			pause(3400),
			line("toolResult", "↳ bash\n20/20 runs: ✓ 3 passing — no flakes."),
			stream(
				"assistant",
				"Fixed. The test raced real timers against the retry backoff schedule; with fake timers advancing the clock past each backoff step it is fully deterministic — 20 consecutive green runs. No production code was touched. Opening the PR.",
			),
			status("pushing"),
			line("status", "▸ Committing on cloud/story-103 → pushing → opening PR…"),
			pause(2200),
			pr(prUrl(43), "cloud/story-103"),
			status("done"),
		],
	},
	];
}

// ── Runner ───────────────────────────────────────────────────────────────────

export interface DemoRunDeps {
	registry: AgentRegistry;
	sessionId: string;
	signal: AbortSignal;
	/** Called after status changes so the extension can refresh its status line. */
	onChange?: () => void;
	/** Speed multiplier (1 = storyboard pace; <1 = faster for rehearsal). */
	speed?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Stream a string into one coalesced transcript entry, word by word. */
async function streamEntry(deps: DemoRunDeps, entryKind: TranscriptEntry["kind"], text: string): Promise<void> {
	const { registry, sessionId, signal } = deps;
	const words = text.split(" ");
	for (let i = 0; i < words.length; i++) {
		if (signal.aborted) return;
		registry.appendDelta(sessionId, entryKind, (i === 0 ? "" : " ") + words[i]);
		await sleep(75 * (deps.speed ?? 1), signal);
	}
}

/** Run one story's script to completion (or until aborted). */
export async function runDemoScript(deps: DemoRunDeps, script: Step[]): Promise<void> {
	const { registry, sessionId, signal, onChange } = deps;
	const speed = deps.speed ?? 1;
	for (const step of script) {
		if (signal.aborted) return;
		switch (step.kind) {
			case "pause":
				await sleep(step.ms * speed, signal);
				continue; // pauses carry their own duration; skip the default gap
			case "status":
				registry.patch(sessionId, { status: step.status });
				onChange?.();
				break;
			case "line":
				registry.appendTranscript(sessionId, { kind: step.entryKind, text: step.text });
				break;
			case "stream":
				await streamEntry(deps, step.entryKind, step.text);
				break;
			case "pr":
				registry.patch(sessionId, { prUrl: step.url, branch: step.branch });
				registry.appendTranscript(sessionId, { kind: "pr", text: `🔗 Pull request opened: ${step.url}` });
				onChange?.();
				break;
		}
		await sleep(550 * speed, signal);
	}
}

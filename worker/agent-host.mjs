// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent child supervisor — the orchestrator's half of the process boundary.
 *
 * Spawns `agent-child.mjs` as the unprivileged user (reusing the same
 * privilege-drop machinery that already wraps LLM-issued shell commands),
 * speaks the narrow stdio protocol from `agent-ipc.mjs`, and exposes
 * an interface shaped like the in-process `AgentSession` so `server.mjs` does not
 * have to care which mode it is in:
 *
 *     const agent = await startAgentProcess({...});
 *     agent.subscribe(handler);         // pi events, verbatim
 *     await agent.prompt("story text"); // resolves when the turn ends
 *     agent.interrupt();                // operator pressed stop
 *     await agent.shutdown();           // waits for exit, THEN the gate runs
 *
 * The `shutdown()`-before-gate ordering is a security property, not politeness:
 * once the child is gone, "the tree that was validated" and "the tree that is
 * pushed" are the same tree by process lifetime rather than by our own ordering
 * discipline (design doc §6).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { createLineDecoder, encodeMessage, isExpected } from "./agent-ipc.mjs";
import { sandboxState, untrustedCommand, untrustedEnv } from "./sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = join(HERE, "agent-child.mjs");

/** Is out-of-process mode requested? Default off until verified on a deployment. */
export function agentIsolationRequested(env = process.env) {
	return /^(1|true|yes)$/i.test(env.CLOUD_MODE_AGENT_OUT_OF_PROCESS ?? "");
}

/** Must a failure to isolate be fatal rather than a warning? */
export function agentIsolationRequired(env = process.env) {
	return /^(1|true|yes)$/i.test(env.CLOUD_MODE_REQUIRE_AGENT_ISOLATION ?? "");
}

/**
 * Build the argv that runs the child under the unprivileged user.
 * Exported for tests: the shape of this command *is* the boundary.
 */
export function buildChildCommand({ nodeBin = process.execPath, entry = CHILD_ENTRY, extraEnv = {} } = {}) {
	// Reuse the audited drop-privilege builder. `env -i` inside it means the child
	// starts from the allow-list, so no AWS_*, GH_*, CLOUD_MODE_* or PI_* variable
	// leaks across — the proxy coordinates are passed explicitly instead.
	const { file, args, env, mode, strategy } = untrustedCommand(`exec "${nodeBin}" "${entry}"`, { extraEnv });
	// `env` matters as much as argv: in separate-uid mode the allow-list is
	// materialised into the `env -i` argv, in the degraded same-uid fallback it is
	// the child's environment object. Tests assert on both.
	return { file, args, env, mode, strategy };
}

/**
 * Start the agent in its own process.
 *
 * @param {object} opts
 * @param {string} opts.cwd            session worktree
 * @param {string} opts.model          pinned model id
 * @param {string} [opts.provider]
 * @param {string} [opts.systemPrompt]
 * @param {{url: string, token: string}} opts.proxy  loopback model proxy coordinates
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.readyTimeoutMs]
 */
export async function startAgentProcess({
	cwd,
	model,
	provider = process.env.PI_PROVIDER ?? "amazon-bedrock",
	systemPrompt,
	proxy,
	log = () => {},
	readyTimeoutMs = Number(process.env.CLOUD_MODE_AGENT_READY_TIMEOUT_MS ?? 60_000),
	spawnFn = spawn,
} = {}) {
	const subscribers = new Set();
	const pendingTurns = new Map();
	let readyInfo;
	let fatal;
	let exited = false;

	// Nothing from our world is passed through the environment: the sandbox's
	// allow-list would strip CLOUD_MODE_*/AWS_* anyway, and the private
	// stdio channel is the better place for a capability — a variable is readable
	// by every descendant of the child, an `init` message is not.
	const { file, args, mode, strategy } = buildChildCommand();

	if (mode !== "separate-uid") {
		const detail = `agent process runs under the SAME uid as the orchestrator (sandbox mode: ${mode})`;
		if (agentIsolationRequired()) {
			throw new Error(
				`CLOUD_MODE_REQUIRE_AGENT_ISOLATION=1 but ${detail}. Refusing to run: the process boundary this ` +
					`deployment claims would not exist.`,
			);
		}
		log(`[cloud-mode] WARNING: ${detail}; the agent process boundary is degraded.`);
	}

	const child = spawnFn(file, args, {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: untrustedEnv({ extra: { CLOUD_MODE_AGENT_CHILD: "1" } }),
	});

	const stderrTail = [];
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderrTail.push(chunk);
		if (stderrTail.length > 50) stderrTail.shift();
		log(`[cloud-mode][agent] ${String(chunk).trimEnd()}`);
	});

	const feed = createLineDecoder(
		(message) => {
			if (!isExpected(message, "child")) {
				log(`[cloud-mode] ignoring unexpected agent message '${message.type}'`);
				return;
			}
			switch (message.type) {
				case "ready":
					readyInfo = message;
					break;
				case "event":
					for (const fn of subscribers) {
						try {
							fn(message.event);
						} catch (err) {
							log(`[cloud-mode] event subscriber threw: ${String(err?.message ?? err)}`);
						}
					}
					break;
				case "turn_done": {
					const pending = pendingTurns.get(message.turnId);
					pendingTurns.delete(message.turnId);
					if (!pending) break;
					if (message.ok) pending.resolve();
					else pending.reject(new Error(message.reason ?? "agent turn failed"));
					break;
				}
				case "fatal":
					fatal = new Error(message.message ?? "agent process reported a fatal error");
					for (const p of pendingTurns.values()) p.reject(fatal);
					pendingTurns.clear();
					break;
				case "log":
					log(`[cloud-mode][agent] ${message.message}`);
					break;
			}
		},
		(problem) => log(`[cloud-mode] agent IPC: ${problem}`),
	);
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", feed);

	child.on("exit", (code, signal) => {
		exited = true;
		const reason = fatal?.message ?? `agent process exited (code ${code}, signal ${signal ?? "none"})`;
		for (const p of pendingTurns.values()) p.reject(new Error(reason));
		pendingTurns.clear();
	});

	function write(message) {
		if (exited) throw fatal ?? new Error("agent process is no longer running");
		child.stdin.write(encodeMessage(message));
	}

	write({ type: "init", cwd, model, provider, systemPrompt, proxy, sandbox: { mode: sandboxState().mode } });

	// Wait for the handshake: a child that cannot reach its proxy or cannot resolve
	// the model must fail at setup, never halfway through a delivery.
	const started = Date.now();
	while (!readyInfo && !fatal && !exited) {
		if (Date.now() - started > readyTimeoutMs) {
			child.kill("SIGKILL");
			throw new Error(
				`agent process did not become ready within ${readyTimeoutMs}ms. stderr tail:\n${stderrTail.join("")}`,
			);
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	if (fatal) throw fatal;
	if (exited) throw new Error(`agent process exited during startup. stderr tail:\n${stderrTail.join("")}`);

	log(
		`[cloud-mode] agent process ready (pid ${readyInfo.pid}, uid ${readyInfo.uid}, ` +
			`isolation: ${mode}${strategy ? `/${strategy}` : ""})`,
	);

	let turnSeq = 0;
	return {
		mode,
		strategy,
		pid: readyInfo.pid,
		uid: readyInfo.uid,
		subscribe(handler) {
			subscribers.add(handler);
			return () => subscribers.delete(handler);
		},
		prompt(text) {
			const turnId = `t${++turnSeq}`;
			return new Promise((resolve, reject) => {
				pendingTurns.set(turnId, { resolve, reject });
				try {
					write({ type: "prompt", turnId, text });
				} catch (err) {
					pendingTurns.delete(turnId);
					reject(err);
				}
			});
		},
		interrupt() {
			try {
				write({ type: "interrupt" });
			} catch {
				/* already gone — stopping a stopped agent is not an error */
			}
		},
		async shutdown({ timeoutMs = 10_000 } = {}) {
			if (exited) return;
			try {
				write({ type: "shutdown" });
			} catch {
				/* fall through to the kill path */
			}
			const deadline = Date.now() + timeoutMs;
			while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
			if (!exited) {
				log("[cloud-mode] agent process did not exit in time; killing it before the validation gate runs");
				child.kill("SIGKILL");
				while (!exited) await new Promise((r) => setTimeout(r, 25));
			}
		},
	};
}

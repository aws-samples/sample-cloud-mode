// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Agent child process.
 *
 * This is the *untrusted half* of the worker: it runs pi's `AgentSession` — the
 * tool loop, the file tools, the model client — under the unprivileged user, with
 * no AWS credential and no GitHub token in reach. See
 * `docs/agent-isolation.md`.
 *
 * It talks to the orchestrator over stdio JSONL only (`agent-ipc.mjs`). There is
 * deliberately no way from here to ask for a secret, run a git command, open a
 * pull request or merge: the orchestrator does delivery itself.
 *
 * Started by `agent-host.mjs`, never directly.
 */

import { createAgentSession, createBashToolDefinition, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { createLineDecoder, encodeMessage, isExpected, sanitizeInit } from "./agent-ipc.mjs";
import { confinedFileOperations, confinedFindOperations } from "./file-confinement.mjs";
import { untrustedBashSpawnHook } from "./sandbox.mjs";
import { PROXY_ACCESS_KEY_ID } from "./model-proxy.mjs";

/** Write one IPC message to the host. */
function send(message) {
	try {
		process.stdout.write(encodeMessage(message));
	} catch (err) {
		// A message we cannot serialise must not take the run down silently.
		process.stderr.write(`[agent-child] failed to send ${message?.type}: ${String(err?.message ?? err)}\n`);
	}
}

let session;
let shuttingDown = false;

async function handleInit(raw) {
	const init = sanitizeInit(raw);
	if (!init.cwd) throw new Error("init without cwd");

	// The model client points at the orchestrator's loopback proxy. This process
	// holds a URL and an opaque bearer token — never an AWS credential.
	if (init.proxy?.url) {
		// The SDK in this process insists on signing, so it is given a DUMMY
		// credential pair whose secret is the proxy capability. The proxy discards
		// that signature and re-signs upstream with the Bedrock-only agent role, so
		// nothing here is an AWS credential: these values grant exactly "call the
		// pinned model through the loopback proxy" and nothing else.
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = init.proxy.url;
		process.env.AWS_ENDPOINT_URL_BEDROCK = init.proxy.url;
		process.env.AWS_ACCESS_KEY_ID = PROXY_ACCESS_KEY_ID;
		process.env.AWS_SECRET_ACCESS_KEY = init.proxy.token;
		delete process.env.AWS_SESSION_TOKEN;
		// Belt and braces: the broker's coordinates must not be inherited here.
		delete process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
		delete process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
	}

	const model = await ModelRuntime.resolve({
		provider: init.provider || "amazon-bedrock",
		model: init.model,
	});

	const confined = confinedFileOperations(init.cwd);
	const sessionManager = SessionManager.inMemory(init.cwd);
	const created = await createAgentSession({
		model,
		cwd: init.cwd,
		sessionManager,
		...(init.systemPrompt ? { systemPrompt: init.systemPrompt } : {}),
		// Same confinement as the in-process mode (increment 1): belt and braces,
		// because a path guard costs nothing and this process is the one driven by
		// untrusted text.
		customTools: [
			createBashToolDefinition(init.cwd, {
				spawnHook: untrustedBashSpawnHook(),
				exposeSessionEnvironment: false,
			}),
			createReadToolDefinition(init.cwd, { operations: confined.read }),
			createWriteToolDefinition(init.cwd, { operations: confined.write }),
			createEditToolDefinition(init.cwd, { operations: confined.edit }),
			createLsToolDefinition(init.cwd, { operations: confined.ls }),
			createGrepToolDefinition(init.cwd, { operations: confined.grep }),
			createFindToolDefinition(init.cwd, { operations: confinedFindOperations(init.cwd) }),
		],
	});
	session = created.session;

	// Every session event is forwarded verbatim, so streaming, attach and steer
	// behave exactly as they did in-process.
	session.subscribe((event) => send({ type: "event", event }));

	send({ type: "ready", pid: process.pid, uid: typeof process.getuid === "function" ? process.getuid() : -1, cwd: init.cwd });
}

async function handlePrompt({ turnId, text }) {
	if (!session) throw new Error("prompt before init");
	try {
		await session.prompt(String(text ?? ""));
		send({ type: "turn_done", turnId, ok: true });
	} catch (err) {
		send({ type: "turn_done", turnId, ok: false, reason: String(err?.message ?? err) });
	}
}

const feed = createLineDecoder(
	(message) => {
		if (!isExpected(message, "host")) {
			process.stderr.write(`[agent-child] ignoring unexpected message '${message.type}'\n`);
			return;
		}
		switch (message.type) {
			case "init":
				handleInit(message).catch((err) => {
					send({ type: "fatal", message: String(err?.message ?? err), stack: err?.stack });
					process.exitCode = 1;
					process.stdin.pause();
				});
				break;
			case "prompt":
				void handlePrompt(message);
				break;
			case "interrupt":
				try {
					session?.interrupt?.();
				} catch {
					/* best effort — the operator asked to stop, not to crash */
				}
				break;
			case "shutdown":
				shuttingDown = true;
				process.stdin.pause();
				// Exit on the next tick so a final flush of stdout lands first.
				setTimeout(() => process.exit(0), 10);
				break;
		}
	},
	(problem) => process.stderr.write(`[agent-child] ${problem}\n`),
);

process.stdin.setEncoding("utf8");
process.stdin.on("data", feed);
process.stdin.on("end", () => {
	if (!shuttingDown) process.exit(0);
});

process.on("uncaughtException", (err) => {
	send({ type: "fatal", message: String(err?.message ?? err), stack: err?.stack });
	process.exit(1);
});
process.on("unhandledRejection", (err) => {
	send({ type: "fatal", message: `unhandled rejection: ${String(err?.message ?? err)}` });
	process.exit(1);
});

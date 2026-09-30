// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AgentCore data-plane transport.
 *
 * A thin seam over the Bedrock AgentCore Runtime data plane (design decision
 * #3): the only backend, but kept behind a small interface so it can be faked
 * in tests. Two capabilities:
 *   - `invokeAgentRuntime` — open a streaming invoke for a runtime session and
 *     yield parsed SSE events live (start a new agent, or steer/prompt an
 *     existing one).
 *   - `stopRuntimeSession` — end an agent's session.
 */

import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
	StopRuntimeSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { parseSseJson } from "./sse.ts";

let cachedClient: BedrockAgentCoreClient | undefined;
let cachedRegion: string | undefined;

function client(region: string): BedrockAgentCoreClient {
	if (!cachedClient || cachedRegion !== region) {
		cachedClient = new BedrockAgentCoreClient({ region });
		cachedRegion = region;
	}
	return cachedClient;
}

export interface InvokeParams {
	region: string;
	agentRuntimeArn: string;
	/** runtime-session-id: attaches to a live agent (AgentCore requires >= 33 chars). */
	sessionId: string;
	/** Endpoint qualifier (e.g. "DEFAULT"). */
	qualifier?: string;
	/** JSON payload delivered to the worker's /invocations. */
	payload: Record<string, unknown>;
	signal?: AbortSignal;
}

/**
 * Invoke the runtime and yield parsed SSE events as they arrive.
 * The returned generator completes when the stream closes.
 */
export async function* invokeAgentRuntime(params: InvokeParams): AsyncGenerator<unknown, void, unknown> {
	const res = await client(params.region).send(
		new InvokeAgentRuntimeCommand({
			agentRuntimeArn: params.agentRuntimeArn,
			runtimeSessionId: params.sessionId,
			qualifier: params.qualifier,
			contentType: "application/json",
			accept: "text/event-stream",
			payload: new TextEncoder().encode(JSON.stringify(params.payload)),
		}),
		{ abortSignal: params.signal },
	);

	const body = res.response;
	if (!body) return;
	// StreamingBlobPayloadOutputTypes is an async iterable of byte chunks in Node.
	yield* parseSseJson(body as AsyncIterable<Uint8Array>);
}

export interface StopParams {
	region: string;
	agentRuntimeArn: string;
	sessionId: string;
	qualifier?: string;
}

export async function stopRuntimeSession(params: StopParams): Promise<void> {
	await client(params.region).send(
		new StopRuntimeSessionCommand({
			agentRuntimeArn: params.agentRuntimeArn,
			runtimeSessionId: params.sessionId,
			qualifier: params.qualifier,
		}),
	);
}

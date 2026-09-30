// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-Sent Events (SSE) parser.
 *
 * AgentCore's `invoke-agent-runtime` returns a `text/event-stream` streaming
 * blob. This turns an async iterable of byte chunks into a stream of parsed
 * JSON event objects (one per `data:` field), tolerating chunk boundaries that
 * split events.
 */

export async function* parseSseJson(
	chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of chunks) {
		buffer += decoder.decode(chunk, { stream: true });
		let sep: number;
		// SSE events are separated by a blank line ("\n\n").
		while ((sep = buffer.indexOf("\n\n")) !== -1) {
			const rawEvent = buffer.slice(0, sep);
			buffer = buffer.slice(sep + 2);
			const parsed = parseEvent(rawEvent);
			if (parsed !== undefined) yield parsed;
		}
	}

	// Flush any trailing event without a terminating blank line.
	const tail = buffer.trim();
	if (tail) {
		const parsed = parseEvent(tail);
		if (parsed !== undefined) yield parsed;
	}
}

function parseEvent(rawEvent: string): unknown {
	const dataLines: string[] = [];
	for (const line of rawEvent.split("\n")) {
		if (line.startsWith("data:")) {
			dataLines.push(line.slice(5).replace(/^ /, ""));
		}
	}
	if (dataLines.length === 0) return undefined;
	const data = dataLines.join("\n");
	if (!data || data === "[DONE]") return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return { type: "raw", text: data };
	}
}

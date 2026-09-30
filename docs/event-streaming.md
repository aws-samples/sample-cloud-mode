# Event streaming and resilient watch

This document describes how the extension observes a running agent: how events
flow from the worker to the overlay, and how the watch survives a dropped
connection, an idle reset, or a pi restart. It describes the code in
`worker/hub.mjs`, `worker/server.mjs`, and `.pi/extensions/cloud-mode/stream.ts`
/ `sse.ts` / `registry.ts`.

---

## 1. The problem being solved

A delegated story runs for minutes to hours. The worker emits pi `AgentSession`
events (messages, tool calls, tool results) plus Cloud Mode lifecycle events
(`cloud_pr`, `cloud_merge`, `cloud_isolation`, `cloud_done`, …). The developer
watches those events in a live overlay.

A single HTTP response cannot be relied on to stay open for the whole run: long
CI waits and quiet phases can reset an idle connection, and the developer may
open the overlay long after the original `start` stream ended. Watching must
therefore be **resumable and idempotent**, independent of any one connection.

---

## 2. Core primitive: sequenced events

Every event the worker emits is stamped with a monotonic per-session `seq`:

```js
{ seq: 42, type: "message_end", message: { ... } }
```

The client remembers the last `seq` it rendered. Any (re)connection asks for
"everything after N" and receives it with no gaps and no duplicates. Dropped
streams, idle resets and overlay reopenings all become non-events.

---

## 3. Worker side

### 3.1 Hub

`worker/hub.mjs` is the per-session fan-out. `emit()` stamps `seq`, appends to a
bounded history, and pushes to every connected response. `subscribe(listener,
sinceSeq)` replays history with `seq > sinceSeq` and then goes live.

The history is bounded (`CLOUD_MODE_MAX_HISTORY_EVENTS`, default 5000) so an
agent that emits for hours cannot exhaust container memory. Terminal events
(`cloud_done`, `cloud_error`, `cloud_pr`, `cloud_merge`, `cloud_isolation`,
`cloud_transcript`) are never pruned, so a late attach always learns the outcome.
When events have been pruned, a replay begins with an explicit
`cloud_history_gap` event; the durable record is the archived transcript in S3,
not this buffer.

### 3.2 Read-only `attach`

`POST /invocations` with `{ action: "attach", sinceSeq }` joins a live session as
a pure observer. No input is delivered to the agent. The response replays
`seq > sinceSeq` and ends; if the agent has already finished, the buffered
history (including the terminal event) is replayed and the response ends
immediately. If the session is no longer known to the container, the worker
answers with a fatal `cloud_error` so the client stops polling.

`attach`, like `steer`, `prompt` and `stop`, requires the session's owner token.

### 3.3 Keepalive

The server writes an SSE comment (`: ping`) every 15 seconds on every open
response. The client's SSE parser ignores comment lines, so this needs no client
logic; it exists to keep idle connections from being reset during quiet phases.

---

## 4. Extension side

### 4.1 `lastSeq` per agent

`registry.ts` tracks `lastSeq` for every agent. `stream.ts` updates it as events
arrive, and it is persisted with the agent entry (`pi.appendEntry`) so it
survives a pi restart. Rendering is idempotent on `seq`: an event that has
already been appended to the transcript is never appended twice, even if two
overlapping connections deliver it.

### 4.2 Resume on drop

When a `start` or `attach` stream ends without a terminal event and the agent's
recorded status is still non-terminal, the extension:

1. Notes `↻ Stream dropped — the agent keeps running; reattaching…` in the
   transcript.
2. Polls the worker's `attach` action every 3 seconds (`POLL_INTERVAL_MS`) with
   `sinceSeq = lastSeq`, until a terminal event arrives or the watch is aborted.

Because of `seq` deduplication, the reconnect is invisible in the rendered
transcript.

### 4.3 Opening the overlay later

Opening `/cloud-mode` on an agent whose original stream has already ended starts
a fresh `attach` watch from `lastSeq`. The overlay is rendered from the in-memory
transcript and re-rendered on every event (`tui.requestRender()`); no pi session
is created or switched.

---

## 5. Limits

- **Container recycle.** Hub history lives in the container's memory. If
  AgentCore recycles the session's microVM, the live history is gone; the
  archived transcript in S3 remains the durable record. The agent itself is not
  resurrected — pi's in-flight `AgentSession` state is not checkpointed — so a
  recycle yields a viewable transcript, not a steerable session.
- **Pruned history.** A client whose `lastSeq` falls before `prunedThroughSeq`
  receives a `cloud_history_gap` event and continues from the oldest retained
  event; the full transcript is in the archive.

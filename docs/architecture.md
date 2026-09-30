# Architecture

This document describes how the sample is built: the compute model on Amazon
Bedrock AgentCore, the worker container contract, the delivery path into GitHub,
and the pi extension that drives it. It is a description of the code in this
repository, not a proposal.

Related documents:

- `docs/agent-isolation.md` — the trust boundaries inside a worker session.
- `docs/event-streaming.md` — how the extension watches a session and survives
  dropped connections.
- `docs/architecture.html` — rendered diagrams of the same architecture.
- `README.md` — installation, configuration, cost and safety guards.

---

## 1. What the sample does

A developer working in a local pi session asks the model to *delegate* a user
story. The `delegate_story` tool starts a fresh session on a deployed AgentCore
Runtime. Inside that session a container clones the target GitHub repository,
runs a pi `AgentSession` against the story, validates the result with the
project's own toolchain, and delivers it — as a pull request by default, or as a
fast-forward commit on the default branch when the project opts in to
`"deliveryMode": "direct-merge"`.

While the remote agent runs, the developer can watch its transcript in a live
overlay, send it additional instructions, or stop it, without leaving their own
pi session.

---

## 2. Compute model

### 2.1 One runtime, one session per story

The CDK stack deploys a single AgentCore Runtime whose container image wraps pi.
Every delegated story invokes that runtime with a fresh `runtime-session-id`,
and AgentCore provisions a dedicated microVM for that session. There is no
cluster to size, no task definitions, and no polling loop: the session exists for
exactly as long as the story is being worked on.

Two AgentCore properties are load-bearing for the design:

- **Session-scoped streaming invoke.** `invoke-agent-runtime` returns a streamed
  response, and further invokes with the same `runtime-session-id` reach the same
  live session. This is the two-way channel used for watching and steering.
- **Per-session isolation.** Each session runs in its own microVM, sanitised on
  termination. This bounds the blast radius of a misbehaving agent to a
  disposable sandbox and a branch. It is a boundary *between* sessions only; the
  boundaries *inside* a session are the sample's own work (`docs/agent-isolation.md`).

### 2.2 Networking

By default the runtime is deployed with `networkMode: VPC` behind an AWS Network
Firewall domain allow-list, so the worker can reach only the hosts it needs
(GitHub, Bedrock, ECR, Secrets Manager, package registries). Setting
`CLOUD_MODE_RESTRICT_EGRESS=0` at deploy time switches to `networkMode: PUBLIC`
with open egress.

---

## 3. Worker container contract

The container is an arm64 image that listens on port 8080 and implements the
AgentCore HTTP protocol:

- `GET /ping` — health check.
- `POST /invocations` — one JSON payload per invoke, with an `action` field:

| Action | Behaviour |
|--------|-----------|
| `start` | Establish the isolation boundaries, mint a GitHub App installation token, clone the repository into a dedicated git worktree, run a pi `AgentSession` on the story, stream every event as `text/event-stream`, deliver the result, archive the transcript. |
| `attach` | Read-only. Replay buffered events with `seq > sinceSeq`, then end. A stateless poll. |
| `prompt` / `steer` | Deliver operator input to the live `AgentSession`. |
| `stop` | End the session. |

Every event carries a monotonic per-session `seq`, and the server writes an SSE
comment ping every 15 seconds so idle connections are not reset during quiet
phases.

The runtime-session-id is required by AgentCore to be at least 33 characters.

### 3.1 Module layout

Each module in `worker/` owns one concern:

| Module | Concern |
|--------|---------|
| `server.mjs` | AgentCore contract, session lifecycle, delivery orchestration |
| `aws-identity.mjs` | Orchestrator vs. agent AWS identity; loopback credential broker |
| `sandbox.mjs` | The single chokepoint for running untrusted code as an unprivileged user |
| `agent-host.mjs`, `agent-child.mjs`, `agent-ipc.mjs` | Running the pi agent in a separate process and talking to it over stdio |
| `model-proxy.mjs` | Loopback proxy that signs Bedrock requests on the agent's behalf |
| `file-confinement.mjs` | Path-confined file tools for the agent |
| `session-guard.mjs` | Admission control: concurrency cap and session ownership |
| `hub.mjs` | Bounded per-session event history with `seq` and gap reporting |
| `git-auth.mjs` | Installation token behind `GIT_ASKPASS` |
| `git.mjs` | Clone, worktree, push, PR creation, auto-merge, CI gate, attribution trailer |
| `integrate.mjs` | Compare-and-swap integration loop for direct merge |
| `llm-resolver.mjs`, `llm-repair.mjs` | Intent-preserving conflict resolution and bounded repair |
| `validate.mjs` | Ecosystem-detecting, fail-closed validation gate |
| `gating.mjs` | Records and reports every safety opt-out used in a run |
| `redact.mjs` | Secret redaction for events and logs |
| `transcript-archive.mjs` | Durable JSONL transcript per session to S3 |
| `secrets.mjs` | GitHub App credentials from Secrets Manager |

### 3.2 pi APIs used by the worker

- `createAgentSession` with `SessionManager.inMemory`, `ModelRuntime.create` and
  `getModel(provider, id)`.
- `session.prompt` / `steer` / `followUp` / `subscribe` / `dispose`.
- `createBashToolDefinition(cwd, { spawnHook })` registered via `customTools` — a
  custom tool overrides the built-in of the same name, which is the seam that
  routes every agent shell command through the sandbox.

---

## 4. Delivery

Delivery is a gate pipeline, not a plain push.

### 4.1 `pull-request` (default)

Push `feature/<storyId>`, open a PR, arm GitHub auto-merge, and wait on CI. If CI
is red the agent is prompted to fix it, up to `CLOUD_MODE_CI_MAX_FIX_ATTEMPTS`
(2) times. If the base branch moves, the branch is rebased and re-gated up to
`CLOUD_MODE_MERGE_MAX_REBASE_ROUNDS` (3) times. The worker never merges itself:
the repository's required status checks decide.

### 4.2 `direct-merge` (opt-in)

Rebase onto the default branch and push with `--ff-only`, using git's non-forced
ref update as a compare-and-swap (8 jittered attempts; `--force` is never used).
Conflicts go to an LLM resolver that must preserve both sides' intent and aborts
loudly on a genuine contradiction. A clean merge that fails validation gets up to
3 bounded LLM repair attempts, re-validated each time.

### 4.3 The validation gate

`validate.mjs` runs the project's own install / format / lint / typecheck / build
/ test steps before anything is pushed — auto-detected per ecosystem, or pinned
with `CLOUD_MODE_VALIDATE_CMD`.

The gate fails closed. An unknown ecosystem, or a step skipped because its
toolchain is missing from the image, fails the run with an actionable message
rather than reading as a pass. `CLOUD_MODE_ALLOW_UNVALIDATED=1` is the explicit
opt-out; it marks the result `skipped: true` so events and logs stay honest.

### 4.4 Branch protection as a precondition

`delegate_story` refuses to launch when the target's default branch has no branch
protection, or is protected but has no required status checks — the two states
in which delivery would be ungated. If protection cannot be verified (no admin
rights on the repository) the tool warns loudly rather than assuming it.
`requireBranchProtection: false` opts out per project.

### 4.5 Operational rules

These are documented in the README rather than enforced in code: delegate only
from a green default-branch commit, batch only stories that touch disjoint
files, and never revert or force-push while agents are in flight.

---

## 5. Extension (client)

The extension lives in `.pi/extensions/cloud-mode/` and is a native pi
extension.

- **`delegate_story`** (`executionMode: "sequential"`) invokes the runtime with a
  fresh session id and consumes the stream. Before launching it checks project
  trust, duplicate story ids, the client-side concurrency cap, that a repository
  is selected, and branch protection.
- **Overlay panel and widget.** Events are rendered into an in-memory transcript
  (`registry.ts`, `panel.ts`, `widget.ts`, `transcript.ts`). Watching an agent
  never creates or switches pi sessions; `esc` returns to the user's own session
  untouched.
- **Resilient watch.** A dropped stream is resumed with `attach` polls from the
  last rendered `seq` (`stream.ts`, `sse.ts`; see `docs/event-streaming.md`).
- **Session ownership.** Each session gets a 256-bit owner token, held in memory
  and replayed on attach/steer (`identity.ts`), so a session id alone is not a
  capability.
- **Attribution.** The delegating principal travels with the story and is
  stamped into the commit trailer and PR body for CloudTrail correlation.
- **Commands.** `/cloud-mode` (or `alt+g`) opens the overlay; `/cloud-mode-setup`,
  `-repo`, `-stop`, `-clear`, `-test` and `-demo` round out the set.

pi APIs used: `pi.registerTool` (with `executionMode`), `pi.registerCommand`,
`pi.registerShortcut`, `pi.appendEntry` for persistence, `ctx.ui.setStatus` /
`select` / `input` / `notify`, and `ctx.isProjectTrusted()`.

---

## 6. Infrastructure (`cdk/`)

`CloudModeStack` provisions:

- **Image.** An arm64 `DockerImageAsset`, base image pinned by digest, with a
  security upgrade applied at build time.
- **Roles.** A runtime role (Secrets Manager read, ECR pull, logs, and
  `sts:AssumeRole` on exactly one ARN), a Bedrock-invoke-only agent role, and an
  operator role with an explicit trust principal.
- **Runtime.** `AWS::BedrockAgentCore::Runtime` (`CfnRuntime`). The DEFAULT
  endpoint is provisioned automatically; the environment carries the model id,
  secret names, agent role ARN, caps and the fail-closed switches.
- **Storage.** A private, encrypted, versioned transcript bucket with a bounded
  lifecycle and a write-only, prefix-scoped grant.
- **Networking.** VPC plus Network Firewall egress allow-list by default
  (`CLOUD_MODE_RESTRICT_EGRESS=0` to disable).
- **Cost.** An optional AWS Budget with 80% and 100% alerts.
- **Parallel stacks.** `CLOUD_MODE_STACK_NAME` and `CLOUD_MODE_RESOURCE_SUFFIX`
  rename every globally unique resource so a test stack can be deployed beside a
  live one.

---

## 7. AgentCore reference

Control plane (`bedrock-agentcore-control`):

- `create-agent-runtime` — `agentRuntimeArtifact.containerConfiguration.containerUri`
  (ECR), `roleArn`, `networkConfiguration.networkMode` ∈ `PUBLIC | VPC`,
  `protocolConfiguration.serverProtocol` ∈ `HTTP | MCP | A2A | AGUI`,
  `environmentVariables`, `lifecycleConfiguration.{idleRuntimeSessionTimeout, maxLifetime}`.

Data plane (`bedrock-agentcore`):

- `invoke-agent-runtime` — `--agent-runtime-arn`, `--payload`,
  `--runtime-session-id` (≥ 33 chars), `--runtime-user-id`, `--qualifier`;
  returns `runtimeSessionId`, `contentType` and a streaming `response`.
- `stop-runtime-session`, `list-sessions`.

Platform behaviour worth knowing when adapting the sample:

- Processes inside the container cannot escalate privileges (`setuid` is
  forbidden). Dropping privileges downward works, which is why the orchestrator
  runs as root and demotes untrusted work with `setpriv`.
- Credentials arrive through the AWS SDK provider chain, not as environment
  variables.
- A container that exits at boot surfaces as **HTTP 424** on invoke; the reason
  is only in CloudWatch Logs.
- The AWS CLI buffers a streamed response and writes it on completion. A client
  that wants incremental rendering must read the response as a live stream
  (SDK EventStream or a chunked HTTP reader), which is what the extension does.

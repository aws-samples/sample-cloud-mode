# Agent isolation

This document describes the trust boundaries inside a single worker session:
which component holds which credential, how untrusted code is kept away from
them, and how the result is reported. It describes the code in `worker/`.

The premise is that the agent is attacker-influenceable by construction. Story
text, repository contents and CI output all reach the model, and the repository's
own build scripts run inside the session. The design therefore assumes that a
prompt injection *succeeds* and bounds what a successful injection can reach.

Amazon Bedrock AgentCore isolates sessions from one another (one microVM per
session). Everything below is about isolation *within* one session.

---

## 1. Components and what they hold

| Component | Driven by | Runs as | Holds |
|---|---|---|---|
| Orchestrator (`server.mjs`) | this repository's code | root in the session microVM | GitHub installation token (memory only), AWS runtime credentials (SDK chain), the delivery logic |
| pi `AgentSession` — tool loop, file tools, model client | model output | `cmagent`, own process (when `CLOUD_MODE_AGENT_OUT_OF_PROCESS=1`) | a loopback proxy URL and a per-process capability token; no AWS or GitHub credential |
| LLM-issued shell commands | model output | `cmagent`, allow-listed environment | nothing |
| Repository build/test scripts | repository content | `cmagent`, allow-listed environment | nothing |

The orchestrator runs as root because AgentCore forbids privilege escalation
inside the container: a non-root process cannot switch users at all, while
dropping privileges downward is always permitted. Root here lives inside a
disposable per-session microVM and is the only component that holds a secret.

---

## 2. Two AWS identities

- **Orchestrator identity** — the AgentCore runtime role: Secrets Manager read,
  ECR pull, CloudWatch Logs, S3 transcript write, and `sts:AssumeRole` on exactly
  one ARN. It is resolved through the SDK provider chain, kept in memory, and
  passed explicitly to the clients that need it.
- **Agent identity** — a second IAM role that can do nothing but invoke the
  pinned Bedrock model. The orchestrator assumes it and vends the resulting
  credentials over a loopback credential broker (`aws-identity.mjs`) guarded by a
  256-bit per-process bearer token.

No AWS credential is ever written into `process.env`. pi's Bedrock provider
performs a presence check for credentials; the broker satisfies it through
`AWS_CONTAINER_CREDENTIALS_FULL_URI` without exposing a secret.

Consequence: arbitrary code execution inside a session yields, at most, a
Bedrock-invoke-only credential. Reading the GitHub App private key from Secrets
Manager is denied to it.

---

## 3. Two OS identities

Every LLM-issued shell command and every repository-supplied build or test
script runs as the unprivileged user **`cmagent`**, through one chokepoint
(`sandbox.mjs`). That chokepoint also hands the process an allow-listed
environment — `PATH`, `HOME`, locale and cache directories only; no `AWS_*`,
`GH_*`, `CLOUD_MODE_*` or `PI_*` variables.

Environment scrubbing alone is deliberately not the control, because same-uid
processes can recover a parent's environment through `/proc`. The uid split is
the control; the scrubbed environment is defence in depth.

---

## 4. The agent in its own process

With `CLOUD_MODE_AGENT_OUT_OF_PROCESS=1`, the pi `AgentSession` itself runs in a
child process as `cmagent`, so the kernel — rather than code discipline —
enforces that the component driven by untrusted text cannot reach a credential
or the delivery mechanism. When the flag is unset the agent runs in the
orchestrator's process with path-confined file tools (§5) and the sandboxed
shell tool; `cloud_isolation` reports which mode is in effect.

```
┌──────────────── session microVM (AgentCore) ────────────────────────────────┐
│                                                                             │
│  ORCHESTRATOR (root)                       AGENT (cmagent)                  │
│  ┌────────────────────────────┐            ┌──────────────────────────────┐ │
│  │ server.mjs                 │            │ agent-child.mjs              │ │
│  │  • HTTP /invocations (SSE) │            │  • createAgentSession()      │ │
│  │  • secrets, git, delivery  │            │  • file tools (confined)     │ │
│  │  • validation gate         │            │  • bash tool (sandboxed)     │ │
│  │  • transcript archive      │            │  • model client → proxy      │ │
│  │                            │            │                              │ │
│  │  installation token ───────┼── never ──▶│                              │ │
│  │  AWS credentials     ──────┼── never ──▶│  (no credentials at all)     │ │
│  │                            │            │                              │ │
│  │  model-proxy.mjs           │◀──HTTP/────│  endpoint override =         │ │
│  │   loopback, bearer-token   │   loopback │    http://127.0.0.1:<port>   │ │
│  │   auth, SigV4 re-signing   │            │                              │ │
│  │                            │            │                              │ │
│  │  agent-host.mjs            │◀──stdio───▶│  agent-ipc.mjs (child)       │ │
│  │   events ◀── │ ── prompt/  │   JSONL    │                              │ │
│  │              │    stop ──▶ │            │                              │ │
│  └────────────────────────────┘            └──────────────────────────────┘ │
│            │                                          │                     │
│            └──────────── shared worktree ─────────────┘                     │
│                 (setgid group, .git orchestrator-only)                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two channels, deliberately different:

- **Control and events: stdio JSONL.** Newline-delimited JSON over the child's
  stdin/stdout. No socket to bind, no port to guess, no ambient namespace — the
  only way to talk to the agent process is to be its parent.
- **Model traffic: loopback HTTP proxy.** The agent's model client points at
  `127.0.0.1:<ephemeral port>`; the orchestrator re-signs each request with the
  Bedrock-only agent role and forwards it.

### 4.1 IPC surface

Every message is one line of JSON. Unknown types are logged and ignored; an
oversized line is dropped so a hostile payload cannot exhaust host memory.

**Child → host**

| Type | Payload | Purpose |
|---|---|---|
| `ready` | `{ pid, uid, cwd }` | Handshake; the host verifies the uid is the unprivileged one |
| `event` | `{ event }` | A pi `AgentSession` event, forwarded verbatim to the hub |
| `turn_done` | `{ turnId, ok, reason? }` | A prompt finished |
| `fatal` | `{ message, stack? }` | The agent cannot continue |
| `log` | `{ level, message }` | Diagnostics (redacted by the host) |

**Host → child**

| Type | Payload | Purpose |
|---|---|---|
| `init` | `{ cwd, model, systemPrompt, proxy: { url, token }, sandbox }` | One-time setup; `proxy.token` is a capability for the loopback proxy, not an AWS credential |
| `prompt` | `{ turnId, text }` | Start or continue a turn (story, CI fix, operator steer) |
| `interrupt` | `{}` | Operator pressed stop |
| `shutdown` | `{}` | Clean teardown |

Secrets, tokens, git operations, PR creation and merges are absent from this
surface by construction: the orchestrator performs delivery itself.

### 4.2 Model proxy

```
agent (cmagent)                 orchestrator (root)                 AWS
  model client ──HTTP──▶ 127.0.0.1:port ──SigV4(agent role)──▶ bedrock-runtime
                         │
                         ├─ bearer token compared with timingSafeEqual
                         ├─ path allow-list: /model/<pinned-id>/invoke* and
                         │   /model/<pinned-id>/converse* only
                         ├─ method allow-list: POST only
                         └─ body streamed through unmodified
```

- Loopback bind only, ephemeral port, 256-bit capability minted per process.
- Two credential shapes are accepted: `Bearer <token>` (constant-time compared)
  or a SigV4 `Authorization` header whose access-key id is the proxy's dummy id
  `CLOUDMODEPROXY0000AK`. The child is given that dummy pair
  (`AWS_ACCESS_KEY_ID` = dummy id, `AWS_SECRET_ACCESS_KEY` = proxy token) plus an
  endpoint override, because an AWS SDK insists on signing; the proxy discards
  the inner signature and re-signs upstream.
- **Model pinning.** Requests for any model id other than the one the runtime
  was deployed with are rejected, so an injected agent cannot switch to a more
  expensive model or another region's endpoint.
- No credential crosses the boundary. Stealing the URL and token buys the
  ability to call one model — which the agent may do anyway — and nothing else.

### 4.3 Delivery integrity

1. The orchestrator sends `shutdown` and waits for the child to exit before
   running the validation gate.
2. The worktree's `.git` is orchestrator-only, so while running the agent cannot
   rewrite history or install a hook.
3. After the gate passes, no agent process exists — the tree that was validated
   is the tree that is pushed, enforced by process lifetime rather than by
   ordering in the orchestrator's code.

For the CI-fix loop the sequence is: start child → prompt → shutdown → gate →
push, with a new child per fix round.

### 4.4 Failure modes

| Failure | Behaviour |
|---|---|
| Privilege drop unavailable | Child starts under the same uid; `cloud_isolation` reports `agentProcess: same-uid`; `CLOUD_MODE_REQUIRE_AGENT_ISOLATION=1` turns this into a hard failure |
| Child exits unexpectedly | `fatal` → the run fails loudly with the child's stderr tail |
| Child hangs | Session `maxLifetime` and idle timeouts apply; `interrupt` then `SIGKILL` on shutdown timeout |
| Proxy unreachable from the child | Handshake fails before the first turn, so the run fails at setup |
| IPC line malformed or oversized | Dropped with a warning |

---

## 5. File tools and the GitHub token

- pi's `read` / `write` / `edit` tools are wrapped so that any path resolving
  (symlink-aware) outside the worktree is refused (`file-confinement.mjs`).
- The GitHub installation token never touches disk. It stays in the
  orchestrator's memory and reaches individual git commands through a
  `GIT_ASKPASS` helper that reads it from that command's environment
  (`git-auth.mjs`). There is no `url.insteadOf` rewrite in `~/.gitconfig` and no
  credential file.
- `core.hooksPath` is pinned to an empty directory so a repository-supplied hook
  can never run in the orchestrator's context.
- The clone's `.git` is orchestrator-only; the worktree is shared with `cmagent`
  through a setgid group.

---

## 6. Reporting and fail-closed switches

The effective posture is emitted as a `cloud_isolation` event and logged:

```
[cloud-mode] credentials: model traffic uses scoped agent role arn:…:role/…AgentRole… (Bedrock invoke only), vended over loopback
[cloud-mode] sandbox: untrusted code runs as OS user 'cmagent' via setpriv (separate uid, scrubbed env)
```

Three switches, all set by the CDK stack, turn a degraded boundary into a
refusal to run stories rather than a quieter log line:

- `CLOUD_MODE_REQUIRE_SCOPED_CREDS=1`
- `CLOUD_MODE_REQUIRE_UID_SANDBOX=1`
- `CLOUD_MODE_REQUIRE_AGENT_ISOLATION=1` (when out-of-process mode is enabled)

---

## 7. What isolation does not cover

- **Content.** The agent still writes the code that gets delivered. Bad code is
  bounded by the validation gate and the repository's required checks, not by
  isolation.
- **Egress.** The agent can reach allow-listed hosts through its shell tool, so
  exfiltrating the worktree to, for example, an attacker-controlled GitHub
  repository remains possible within the allow-list.
- **Spend.** The agent can call the pinned model; Bedrock token spend is bounded
  by session caps and `maxLifetime`.
- **Inner signature.** The proxy checks the dummy key id and the presence of a
  signature but does not recompute it. A process already inside the container
  that can reach loopback could invoke the pinned model without the token. The
  only such processes are the agent and its descendants (which may call the
  model legitimately) and the orchestrator.
- **Container escape.** The orchestrator is root inside the microVM. A kernel or
  container escape is out of scope for this sample; AgentCore's per-session
  microVM is the boundary relied on there.
- **Source exposure to the model.** Repository contents are sent to Bedrock as
  part of normal operation; see the README on data handling.

Tests that exercise these boundaries live in `tests/` (in particular
`tests/agent-isolation-container.sh`, `tests/sandbox-container.sh`,
`tests/aws-identity.test.mjs` and `tests/file-confinement.test.mjs`).

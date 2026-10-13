# Sample: hosting an open-source coding agent on Amazon Bedrock AgentCore

This sample runs the open-source coding agent [pi](https://github.com/earendil-works/pi-mono)
on **Amazon Bedrock AgentCore Runtime**. From a local pi session you hand off a
task (a "story"). The agent runs it in your AWS account and delivers the
result to a GitHub repository.

> **Sample code, not production-ready.** Provided "AS IS" under MIT-0 (see
> [LICENSE](LICENSE) and [NOTICE](NOTICE)); not a supported AWS service. Review
> it against your own security requirements before you deploy it, especially
> [Security considerations](#security-considerations) and the
> [IAM ⇒ GitHub access model](#access-model--iam--github-read-this-in-shared-aws-accounts).

## What it does

1. You ask pi to delegate a story. pi shows the target repository, base branch,
   delivery mode and story text, and asks you to confirm.
2. Each story runs in its own AgentCore session (a separate microVM). The agent
   clones the repository with a short-lived GitHub App token, works in a
   dedicated git worktree, and runs your validation command if you configured
   one (`CLOUD_MODE_VALIDATE_CMD`).
3. The result is a **pull request** (default) or a **direct commit to the
   default branch** (`deliveryMode: "direct-merge"`).
4. While an agent runs, you can watch its transcript live and steer or stop it
   from your local pi session.

```
Local pi session                          Your AWS account
┌───────────────────────────┐  Invoke   ┌────────────────────────────┐
│ delegate_story (LLM tool)  │──────────▶│ AgentCore Runtime session   │
│ /cloud-mode   (live panel) │   SSE     │  pi SDK agent               │
│ alt+g         (open panel) │◀──────────│  → git worktree → PR/commit │
│ overlay: watch/steer/stop  │  stream   │                             │
└───────────────────────────┘           └────────────────────────────┘
```

## What gets deployed

One CDK stack (`cdk/`) creates:

- an AgentCore Runtime and the worker container image (arm64, in Amazon ECR)
- IAM roles for the runtime and for operators who invoke it
- three AWS Secrets Manager secrets for the GitHub App credentials
- an encrypted, versioned S3 bucket for session transcripts (deleted after 90 days)
- CloudWatch log groups with bounded retention
- by default, a VPC with a NAT gateway, AWS Network Firewall and VPC endpoints,
  so the agent can reach only allow-listed domains

## Things to know before you deploy

- **Cost.** Restricted egress (the default) bills the NAT gateway, Network
  Firewall and VPC endpoints **per hour, even when no agent is running**.
  Each story also adds AgentCore session time and Bedrock tokens. To deploy
  without restricted egress, use `CLOUD_MODE_RESTRICT_EGRESS=0`.
- **Data stays in your account.** Prompts, source code and model calls go to
  Amazon Bedrock with your credentials. The sample has no telemetry. The default
  model is a cross-region inference profile; pin a regional model ID if data
  residency matters (see [Your data and service improvement](#your-data-and-service-improvement)).
- **What the agent can write to.** The GitHub App installation defines which
  repositories the agent can push to. Install it on selected repositories
  only. In pi, `delegableRepos` limits the targets further (default: the
  repository you selected).
- **Safeguards.** Delegation is refused if the default branch has no branch
  protection or required status checks. Concurrent sessions are capped (default
  5 per extension, 8 per runtime). Credential-shaped strings are masked in
  transcripts and logs.
- **Supported setups.** GitHub (github.com) only, AWS only, models on Amazon
  Bedrock only. Details below.

## Requirements & limitations (read first)

Cloud Mode is currently **GitHub-only and AWS-only**:

| Area | Requirement | Not supported |
|------|-------------|---------------|
| Git hosting | Repos on **github.com**; a **GitHub App** opens PRs; local `gh` CLI login for the repo picker | GitLab, Bitbucket, self-hosted Git |
| Compute | An **AWS account**; agents run on **Amazon Bedrock AgentCore** | Other clouds, local-only execution |
| LLM | **Bedrock-hosted Claude** models (model access enabled in your region) | OpenAI, Anthropic API keys, other providers |
| Tooling | Node.js 20+, Docker (image build), `aws` CLI, `gh` CLI | — |
| GitHub App scope | The App **must** be installed with **"Only select repositories"**, listing just the repos Cloud Mode may write to — that installation *is* the repository allow-list of the whole system | "All repositories" (an org-wide installation makes every risk in this system org-scoped) |
| Worker image | Must ship the **compilers, runtimes, and libraries the target project needs to build and test** (see [Project toolchains in the worker image](#project-toolchains-in-the-worker-image)) | A stack whose toolchain isn't in the image (its validation step is skipped) |
| 💰 Cost | Every delegated story starts a **billable** AgentCore session + Bedrock tokens (`maxConcurrentAgents` cap built in; each launch asks for confirmation unless `autoConfirm` is set) | — |

## Quick start (recommended)

Onboarding is split into the one-time infra provisioning (terminal) and an
interactive in-pi wizard that handles everything else:

```bash
./scripts/setup.sh      # one-time: prereq checks + cdk deploy + npm install
```

Then start pi in the project (trust it when asked) and run:

```
/cloud-mode-setup
```

The wizard checks every requirement and **offers to fix what's missing in
place**: it prompts for region + GitHub owner and auto-fills the runtime ARN
from the deployed stack (writes `.pi/cloud-mode.json`), creates & installs the
GitHub App (two browser clicks, secrets stored automatically), and opens the
repo picker. Re-running it is idempotent — it only prompts for what's still
missing and ends with a full status report.

Then just ask the model: *"Delegate STORY-1: add a healthcheck endpoint."*

If anything is missing, pi shows a *"Cloud Mode is not configured"* nudge on
startup pointing you back to `/cloud-mode-setup`.

## Components

| Path | What |
|------|------|
| `.pi/extensions/cloud-mode/` | The pi extension (tool, commands, shortcuts, transport) |
| `worker/` | The AgentCore Runtime container (`server.mjs` wrapping the pi SDK) |
| `cdk/` | CDK stack: AgentCore Runtime + endpoint, IAM roles, secrets, ECR image |
| `.pi/cloud-mode.example.json` | Template for project config |

## Architecture

- **Compute:** one deployed **AgentCore Runtime** (the pi container). Each
  delegated story = a fresh `runtime-session-id` in its own microVM. No cluster,
  task definitions or polling loop to manage.
- **Transport:** AgentCore's session-scoped **streaming invoke** gives the
  two-way channel: the first invoke opens a `text/event-stream` for the life of
  the run; same-session invokes deliver steer / prompt input to the live agent.
- **Worker contract:** the container serves `GET /ping` (health) and
  `POST /invocations` (SSE). The first invoke mints a GitHub App token, clones +
  worktrees the repo, runs a pi `AgentSession` on the story, streams its events,
  then commits / pushes and, per the project's `deliveryMode`, either opens a PR
  (emitting the PR URL) or merges directly to the default branch (emitting the
  commit SHA).
- **Rendering (live overlay, no session switch):** each agent keeps an in-memory
  transcript buffer that its SSE stream appends to; a tiny registry pub/sub makes
  the always-on editor **widget** and the `/cloud-mode` **overlay panel** re-render
  on every event (`tui.requestRender()`). Your local pi session is never touched,
  so updates are truly live and returning to your work is just `esc`.

## Design decisions (baked in)

1. **Package:** `@earendil-works/pi-coding-agent@1.2.0` (pinned, local + image).
2. **Backend:** **Bedrock AgentCore Runtime only** — single backend, thin transport seam.
3. **Secrets:** GitHub App creds live in **AWS Secrets Manager**; the worker reads
   them via its runtime role. The LLM is reached via **Amazon Bedrock** using the
   same role (no LLM key).
4. **Worker mode:** pi **SDK `AgentSession`** in-process (not the CLI), so events
   stream out as SSE and interactive input can be delivered mid-run.
5. **Rendering:** a **live overlay + editor widget** driven by an in-memory
   transcript buffer — the extension never creates or switches pi sessions.
6. **Config:** `.pi/cloud-mode.json` (only when project trusted) with `CLOUD_MODE_*` env overrides.
7. **Worker GitHub auth:** a **GitHub App** installation token (minted per run),
   so push/PR access always matches whatever repo the picker chose.

## Manual setup

Prefer to do it by hand (or need to customize)? These are the steps the
infra script and the `/cloud-mode-setup` wizard automate.

### 1. Deploy infrastructure

```bash
cd cdk
npm install
npx cdk bootstrap        # first time only
npx cdk deploy           # builds the arm64 worker image + creates the runtime
```

**Restricted worker egress is ON by default.**
`cdk deploy` runs the runtime in `networkMode: VPC` behind an AWS Network
Firewall that only allows outbound HTTP/TLS to an allow-list — `github.com`,
`*.github.com`, `*.githubusercontent.com`, `registry.npmjs.org`, plus the PyPI /
crates.io / Go / Debian hosts a validation gate typically needs. Everything else
is dropped and alerted to CloudWatch Logs. AWS services the worker needs
(Bedrock, Secrets Manager, ECR, CloudWatch Logs) are reached via VPC endpoints.

This is the default because prompt injection is *assumed to succeed*: with
open egress, an injected agent can POST your worktree anywhere. If your
validation gate needs additional hosts (a private registry), allow them with a
comma-separated list — prefix with a dot to include subdomains:

```bash
CLOUD_MODE_EXTRA_EGRESS_DOMAINS="registry.mycorp.dev,.mycorp.dev" npx cdk deploy
```

> 💰 **This costs money**: NAT gateway, Network Firewall and VPC endpoints are
> billed per hour whether or not an agent is running, and the region must have
> AgentCore-supported Availability Zones. To deploy the cheaper, unrestricted
> configuration, opt out explicitly:
>
> ```bash
> CLOUD_MODE_RESTRICT_EGRESS=0 npx cdk deploy   # networkMode: PUBLIC, open egress
> ```
>
> The `EgressRestricted` stack output records which posture you deployed, and a
> CDK invariant test (`cdk/test/egress.test.mjs`) fails the build if the default
> ever regresses to open egress.

**Deploying a second, isolated stack (recommended before changing a live one).**
Globally-named resources (secrets, runtime name, firewall names) are suffixed on
request, so a test stack can live beside a production one without touching it:

```bash
CLOUD_MODE_STACK_NAME=CloudModeStackIsoTest \
CLOUD_MODE_RESOURCE_SUFFIX=isotest \
  npx cdk deploy
# → secrets cloud-mode/gh-*-isotest, runtime cloud_mode_worker_isotest
```

Populate the suffixed secrets for that stack, point a scratch
`.pi/cloud-mode.json` at its `AgentRuntimeArn`, and delete it with
`CLOUD_MODE_STACK_NAME=CloudModeStackIsoTest npx cdk destroy` when done. Without
the suffix the names are exactly as before, so an existing deployment is never
renamed underneath itself.

Populate the secrets created by the stack:

```bash
aws secretsmanager put-secret-value --secret-id cloud-mode/gh-app-id            --secret-string "123456"
aws secretsmanager put-secret-value --secret-id cloud-mode/gh-installation-id   --secret-string "789012"
aws secretsmanager put-secret-value --secret-id cloud-mode/gh-app-private-key   --secret-string "$(cat cloud-mode-agent.private-key.pem)"
```

(Or use `scripts/put-secrets.sh`, or let `scripts/create-github-app.mjs` create
the GitHub App and write all three secrets for you.)

The LLM is accessed via **Amazon Bedrock**. By default the stack creates a
separate, Bedrock-only **agent role** (`AgentRoleArn` output) that the worker
assumes for all model traffic, so the identity reachable from inside a session
cannot read the GitHub App key — see
[Isolation inside the session](#isolation-inside-the-session). No API key secret
is needed. Ensure Bedrock **model access** is enabled for the chosen Claude model
in the stack region (Bedrock console → Model access).

Some newer models reject the account's `default` data retention mode and fail
with a 400 `ValidationException` (*"data retention mode 'default' is not
available for this model"*). If you hit this, set the account-wide retention
mode once per region:

```bash
REGION=us-east-1 ./scripts/set-data-retention.sh   # sets mode=provider_data_share
```

⚠️ This is **account-wide** (affects all Bedrock calls in that region) and
`provider_data_share` **opts the account into sharing content with the model
provider**. Treat it as a deliberate data-handling decision, not a quick fix —
see [Your data and service improvement](#your-data-and-service-improvement)
below. See the
[data retention docs](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html).

### Your data and service improvement

Cloud Mode runs entirely in **your** AWS account and calls Amazon Bedrock with
**your** credentials. Story text, the repository source the agent reads and
writes, and all model interactions are sent to Bedrock from your account — this
project operates no service, collects no telemetry, and never routes your content
through an account it controls.

Because the calls are yours, the data-handling controls are yours too:

- **Service-improvement processing** is governed by the AWS **AI services
  opt-out policy** at the AWS Organizations level, enforced by Bedrock — not by
  any setting in this project. If you do not want content processed by an AI
  service to be used for developing or improving that service, enable that
  policy for your organization. See the
  [AI services opt-out policy docs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html).
- **`scripts/set-data-retention.sh`** changes an **account-wide, per-region**
  Bedrock retention mode. It defaults to the narrower `aws_review` (content is
  kept from the model provider); `MODE=provider_data_share` is the broadest
  opt-in and should only be used if a model you deliberately chose requires it.
  Review either against your opt-out policy and your organization's
  data-handling rules before running it; prefer selecting a model that works
  with your existing retention mode, or scoping the decision with **Bedrock
  Projects** (per-project retention) instead of an account-wide setting.
- **Data residency.** The default model id `global.anthropic.claude-opus-5` is a
  **cross-region inference profile**: a request may be served from a region other
  than the one you deploy into. Pin a region-specific model id if residency is
  constrained for you.
- **Transcripts** (which may quote proprietary source) stay in your account: a
  private, encrypted, versioned S3 bucket with bounded retention, plus
  CloudWatch logs with bounded retention. Both are yours to delete.

Create a **GitHub App** (org/user settings → Developer settings → GitHub Apps):
permissions `Contents: Read/Write`, `Pull requests: Read/Write`; install it with
**"Only select repositories"** and list just the repos of `githubOwner` that Cloud
Mode may write to. An org-wide ("All repositories") installation is **not a
supported configuration**: it turns every risk in this system from repo-scoped
into org-scoped, because anyone who can invoke the runtime can then make an agent
push to every repository in the org. Use its App ID, Installation ID,
and a generated private key for the secrets above. Easiest:

```bash
APP_OWNER=<your-github-user-or-org> REGION=<region> node scripts/create-github-app.mjs
```

### 2. Configure the extension

Copy the template and fill it with the `cdk deploy` outputs:

```bash
cp .pi/cloud-mode.example.json .pi/cloud-mode.json
# edit region / agentRuntimeArn (AgentRuntimeArn output) / githubOwner
# optional: set "deliveryMode" to "pull-request" (default) or "direct-merge"
# optional: "delegableRepos": ["owner/repo", "owner/*"] — which repositories this
#           project may delegate to (default: the selected repo only)
# optional: "autoConfirm": true — skip the pre-launch confirmation (batch use)
```

**Which repositories may this project delegate to?** `delegate_story` is invoked
by the *model*, and its repo target and story text both come out of a model turn.
So the target is constrained twice: by `delegableRepos` (default: only the
repository you selected with `/cloud-mode-repo`) and by a confirmation prompt
showing the resolved repo, base branch, delivery mode and story before anything
launches. `autoConfirm: true` (or `CLOUD_MODE_AUTO_CONFIRM=1`) skips the prompt
for unattended batches — it never widens the allow-list.

Install extension deps:

```bash
cd .pi/extensions/cloud-mode && npm install
```

Make sure your local AWS credentials can invoke the runtime
(`bedrock-agentcore:InvokeAgentRuntime`, `bedrock-agentcore:StopRuntimeSession` —
see the `OperatorRoleArn` output).

### 3. Use it

In a trusted project, start pi and:

- `/cloud-mode-setup` — interactive onboarding wizard: verifies config, AWS
  credentials, GitHub auth, App secrets, and repo selection — and fixes what it
  can in place. Prints the current restrictions and a final status report.
- `/cloud-mode-repo` — pick (↑↓, type to filter) or create the target repo.
- Ask the model to work, e.g. *"Delegate STORY-42: add pagination to the users API."*
  The `delegate_story` tool asks you to confirm the repo, branch, delivery mode
  and story, then launches a cloud agent (`autoConfirm: true` skips the prompt).
  A live status strip appears above your editor right away.
- `/cloud-mode` (or `alt+g`) — open the **live overlay panel**. It shows the
  selected agent's transcript and updates in real time as the agent works.
  - `←` / `→` (or `p` / `n`) — cycle between agents.
  - `↑` / `↓` (or `k` / `j`) — scroll; `g` / `G` jump to top / bottom.
  - `s` — steer / re-prompt the focused agent.
  - `x` — stop the focused agent.
  - `esc` (or `q`) — close the overlay and return to your local pi session,
    exactly where you left it (your session was never switched).
- `/cloud-mode-stop` — stop a running agent (also available as `x` in the panel).

> No more manual refresh: because the overlay renders from an in-memory buffer
> and re-renders on every streamed event, a running agent updates live. Nothing
> is written to or switched in your pi session, so `esc` always takes you home.

## Delivery mode

Each project chooses how a completed story is delivered via `deliveryMode` in
`.pi/cloud-mode.json` (or the `CLOUD_MODE_DELIVERY_MODE` env override):

| Value | Behavior | When to use |
|-------|----------|-------------|
| `"pull-request"` *(default)* | Commit to a `feature/<storyId>` branch, open a PR, run the CI gate, return the PR URL. | Normal review-based workflows. |
| `"direct-merge"` | Land the story's commit(s) **straight on the default branch** (from `cloud-mode.state.json` → `repo.defaultBranch`) with no PR; return the commit SHA. | Review-free / dark-launch teams (no branch protection; features ship behind flags and are released separately), where an always-on PR step is pure overhead. |

Notes:

- Absent field ⇒ `"pull-request"` (today's behavior, fully backward compatible).
- An unknown value is rejected at config-load time with a clear error — Cloud
  Mode never silently falls back.
- **`direct-merge` triggers whatever push-to-default-branch automation the repo
  has** (CI / deploy), because the commit lands on the default branch
  immediately. Use it only where that's intended.
- If a `direct-merge` push is rejected (branch protection or a required status
  check still enforced on the default branch), the agent **fails loudly** with an
  actionable message rather than opening a PR behind your back. **The recommended
  fix is to switch back to `"pull-request"`** — do *not* exempt the Cloud Mode
  GitHub App from the branch-protection rule. The App is deliberately not an
  admin and cannot bypass protection, and that non-bypassability is what bounds
  the installation token; exempting it removes the control
  the rest of the model relies on.
- `direct-merge` is therefore only for a repository **whose existing protection
  rules already permit the App to push to the default branch** — configured by
  the repo's owners for their own reasons, not loosened for Cloud Mode. Keep the
  blast radius in view: an AWS `InvokeAgentRuntime` permission is transitively
  GitHub **write** access to every repo the App is installed on (see [Access
  model — IAM ⇒ GitHub](#access-model--iam--github)), so under `direct-merge`
  that permission lands model-authored commits on a default branch with no human
  review step.
- Concurrent stories (`maxConcurrentAgents > 1`) racing to the same default
  branch are handled by a decentralized, optimistic **rebase + fast-forward
  push** integration loop: a timing race (non-fast-forward push) is retried with
  exponential backoff + jitter; a content conflict against concurrently-landed
  work is **auto-resolved** (LLM-backed, preserving both sides' intent) and
  re-validated before pushing. A genuine contradiction aborts loudly.

### Validation gate (`CLOUD_MODE_VALIDATE_CMD`) — set this for `direct-merge`

Because the integration loop can rebase and **auto-resolve conflicts** before
pushing, it runs a **validation command on the resolved tree and refuses to push
if it fails**. This is what stops a bad auto-resolution (or a broken change)
from landing on your default branch.

- Configure it at deploy time via the `CLOUD_MODE_VALIDATE_CMD` env var (read by
  the CDK stack and baked into the runtime). `scripts/setup.sh` **prompts for it**
  during install; to set/change it later, re-run with it exported:

  ```bash
  CLOUD_MODE_VALIDATE_CMD="pnpm install --frozen-lockfile && pnpm test" REGION=us-east-1 ./scripts/setup.sh
  ```

- The command runs inside the cloned repo; a **non-zero exit blocks the push**.
- **Unset ⇒ the worker auto-detects the project** and validates it (see
  `worker/validate.mjs`): pnpm/npm/yarn/bun for Node, and best-effort
  python/rust/go/jvm/ruby. Package managers are chosen from the lockfile
  present (e.g. `pnpm-lock.yaml` → pnpm, `package-lock.json` → `npm ci`), and
  ecosystems whose toolchain is not in the runtime image **skip gracefully**
  (a logged pass) rather than failing. Set `CLOUD_MODE_VALIDATE_CMD` to pin an
  exact command for a repo. `/cloud-mode-setup` reports the gate's current mode.

> `direct-merge` support lives in the worker container, so the runtime image
> must include this change: redeploy the worker once with `cd cdk && npx cdk deploy`
> (rebuilds the arm64 image + updates the runtime). After that, `deliveryMode`
> takes effect on the next `delegate_story` call — the extension passes the mode
> to the worker per invocation, so no further redeploy is needed to switch modes.

## Project toolchains in the worker image

The agent does its work **inside the worker container**: it clones the target
repo there, and the integration/validation gate **compiles and tests the project
in that same container** before pushing. So the runtime image must contain every
tool the project needs to build and test itself — language runtimes, compilers,
package managers, system libraries, headers, and any CLI the test/build scripts
shell out to.

If a required toolchain is missing:

- the auto-detecting gate **skips** that ecosystem (a logged pass) rather than
  failing — so a broken change can land undetected, and
- the agent itself can't run the project's build/test commands mid-task, which
  degrades the quality of what it produces.

The base image (`worker/Dockerfile`) ships **Node.js, git, and the GitHub CLI**
only. **Add whatever your project needs** and redeploy the runtime. For example:

```dockerfile
# worker/Dockerfile — extend the system-deps layer with your project's toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \   # Python projects
      openjdk-17-jdk maven \               # JVM projects
      build-essential pkg-config libssl-dev # native deps / headers
    && rm -rf /var/lib/apt/lists/*

# Toolchains that aren't apt packages (installed to a PATH the runtime user sees):
# RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y      # Rust
# RUN curl -fsSL https://go.dev/dl/go1.22.linux-arm64.tar.gz | tar -C /usr/local -xz
```

Notes:

- The image is **arm64** — pick arm64 builds/binaries for anything you add.
- After changing the Dockerfile, **redeploy the worker once**
  (`cd cdk && npx cdk deploy`) to rebuild and update the runtime.
- Pin an exact build/test command for a repo with `CLOUD_MODE_VALIDATE_CMD`
  (see [Validation gate](#validation-gate-cloud_mode_validate_cmd--set-this-for-direct-merge)).
- Build and test steps run as the unprivileged user `cmagent` with a scrubbed
  environment (see [Isolation inside the session](#isolation-inside-the-session)),
  so install anything they need **into the image** rather than expecting a
  writable `$HOME` or ambient credentials. Shared caches are provided at
  `/opt/cloud-mode-cache` (`COREPACK_HOME`, `npm_config_cache`,
  `XDG_CACHE_HOME`); if a build needs an extra variable, name it in
  `CLOUD_MODE_UNTRUSTED_ENV_PASSTHROUGH` (comma-separated) — secret-shaped names
  are still refused.

## Isolation inside the session

> **Demo-grade by intent.** This is an *illustrative* containment design, not a
> hardened one: it has not been adversarially tested, and a uid split inside one
> container is defence in depth rather than a trust boundary. See [Security
> considerations](#security-considerations) for the production alternative to each
> choice below.

The agent is assumed to be attacker-influenceable (story text, repository
contents and CI logs all reach the model), so the container is split in two:

| | Orchestrator | Untrusted code |
|---|---|---|
| What | `server.mjs`, git, delivery, the validation gate's *driver* | Every shell command the LLM runs, plus the repo's own build/test/lint scripts |
| OS user | `node` | `cmagent` (separate uid, shared group `cmwork` for the worktree) |
| Environment | GitHub token in a 0600 file, AWS credentials in memory | Allow-list only: `PATH`, `HOME`, locale, caches — no `AWS_*`, `GH_*`, `CLOUD_MODE_*`, `PI_*` |
| AWS identity | Runtime role (Secrets Manager, ECR, logs, assume the agent role) | none |

The model traffic itself runs on a **separate, Bedrock-only IAM role**
(`AgentRoleArn` output) that the worker assumes and serves over a loopback
credential broker. No AWS credential is ever written into the environment, so
code execution inside a session cannot read the GitHub App private key — it
reaches, at worst, an identity that can only invoke the model. The GitHub
installation token likewise never touches disk: it stays in the orchestrator's
memory and is handed to individual git commands through a `GIT_ASKPASS` helper.

Because Bedrock AgentCore forbids setuid inside the container, the privilege drop
uses `setpriv` from a root orchestrator rather than `sudo`. That means the
orchestrator process is root **inside a disposable per-session microVM**, while
everything an attacker can influence runs as `cmagent`. The mechanism actually in
use is reported in the `cloud_isolation` event and in the log:

```
[cloud-mode] credentials: model traffic uses scoped agent role arn:…:role/…AgentRole… (Bedrock invoke only), vended over loopback
[cloud-mode] sandbox: untrusted code runs as OS user 'cmagent' via setpriv (separate uid, scrubbed env)
```

Both boundaries **fail closed** by default: the runtime is deployed with
`CLOUD_MODE_REQUIRE_SCOPED_CREDS=1` and `CLOUD_MODE_REQUIRE_UID_SANDBOX=1`, so a
worker that cannot establish them refuses to run stories instead of running with
less isolation than you think. Relax with `CLOUD_MODE_SCOPED_AGENT_ROLE=0` /
`CLOUD_MODE_REQUIRE_ISOLATION=0` at deploy time if a platform forces you to.

Verify it against the real image at any time (no AWS account involved):

```bash
./tests/sandbox-container.sh      # builds worker/ and asserts the boundaries in-container
node --test "tests/*.test.mjs"    # unit tests, incl. credential/env leak canaries
node --test "cdk/test/*.test.mjs" # IAM scoping of the agent role
```

## Building & verifying

One command is the whole gate — run it before you deploy or open a PR:

```bash
npm run verify       # unit tests + CDK invariant assertions + static analysis
```

| Step | What it enforces |
|------|------------------|
| `npm test` | Worker + extension unit tests, incl. credential/env leak canaries |
| `npm run test:infra` | IAM scoping, credential split, bucket privacy, admission control |
| `npm run sast` | Static analysis of **our own source** |
| `npm run audit` | Production dependency advisories (blocking) |
| `npm run typecheck` | Advisory: needs the pi SDK present (host-provided at runtime) |

### Static analysis (`npm run sast`)

Cloud Mode is an extension to an existing coding agent, so there is no service
pipeline to gate — the build *is* the enforcement point. `scripts/static-analysis.sh`
runs a **local** semgrep ruleset (`scripts/sast-rules.yml`) over the extension,
CDK app, worker, scripts and tests. Local rules mean no registry download: the
gate behaves identically offline and in a fresh clone.

Rules target the classes that actually apply to a memory-safe codebase that
deliberately executes untrusted repository code and model-derived shell commands:

- **blocking (ERROR)** — shell/dynamic-code injection, hardcoded or logged
  secrets, `Math.random()` for tokens, timing-unsafe secret comparison, disabled
  TLS verification, non-loopback plaintext `http://`, wildcard IAM actions;
- **advisory (WARNING)** — wildcard IAM resources, `shell: true`, hygiene.

It **fails closed**: with no analyzer installed the scan is not silently skipped
(`ALLOW_NO_SAST=1` overrides; `SAST_REGISTRY=1` adds the community rulesets).
Install one of `semgrep` / `uvx` / `pipx` / `docker`, plus `shellcheck` for the
shell scripts.

Triage a false positive **at the call site** — that comment is the record:

```ts
// ecr:GetAuthorizationToken takes no resource (the API rejects any ARN).
// nosemgrep: cloud-mode-iam-wildcard-resource
```

`tests/static-analysis.test.mjs` asserts every blocking rule still fires on a
known-bad snippet, so the gate cannot quietly decay into a no-op.
What is *not* isolated yet: pi's in-process file tools and model client still run
in the orchestrator's context.

## Cost & safety guards

- Each `delegate_story` launch asks for confirmation; `autoConfirm: true` (or
  `CLOUD_MODE_AUTO_CONFIRM=1`) skips the prompt for unattended batches.
- **Two concurrency caps.** `maxConcurrentAgents` (extension, default 5) gives
  fast feedback; `CLOUD_MODE_MAX_ACTIVE_SESSIONS` (worker, default 8) is the
  authoritative one, so a runaway retry loop or a second IAM principal cannot
  start unbounded sessions. Excess starts are rejected with `concurrency_limit`.
- **Optional budget.** Deploy with `CLOUD_MODE_MONTHLY_BUDGET_USD=300
  CLOUD_MODE_BUDGET_EMAIL=you@example.com` for 80%/100% AWS Budgets alerts.
  Advisory — Budgets notify, they do not stop anything.
- **Gate preconditions.** Delegation refuses a default branch without branch
  protection, without required status checks, or that still **allows force
  pushes** (`requireBranchProtection: false` opts out of all three), and the
  worker's validation gate fails closed when it cannot run
  (`CLOUD_MODE_ALLOW_UNVALIDATED=1` opts out, and marks the run `skipped`).
- **An ungated delivery says so.** Using either escape hatch stamps
  `Cloud-Mode-Ungated: <reason>` into the commit trailer, prepends a warning
  block to the PR body, emits a `cloud_warning` event, and is listed by
  `/cloud-mode-setup` — so "nothing checked this" can never look like "the checks
  passed".
- **Org-wide installation is called out.** If the GitHub App is installed on *All
  repositories*, the extension warns once per session: every risk in the system
  becomes org-scoped.
- **Transcripts are redacted.** Credential-shaped strings (AWS keys, `ghp_`/
  `github_pat_` tokens, PEM blocks, bearer headers, secret-ish `KEY=value`
  assignments) are masked before anything is written to S3 or CloudWatch; source
  code is deliberately kept.
- **The agent's file tools cannot leave the worktree.** `/proc/self/environ`, the
  clone's `.git`, the token directory and anything outside the worktree are
  refused on the resolved, symlink-aware path.
- **Session ownership.** Each session carries a 256-bit owner token held only by
  the delegating pi process, so a leaked session id cannot be used to read a
  transcript or steer an agent.
- **Forensics.** Every session writes a JSONL transcript to the stack's
  `TranscriptBucketName` (90-day lifecycle); commits and PRs carry a
  `Cloud-Mode-Session` / `Cloud-Mode-Delegated-By` trailer for one-hop CloudTrail
  correlation.
- Every background SSE stream owns an `AbortController`; all are torn down on
  `session_shutdown` (no leaking invokes).

### After a deploy (one-off hardening)

```bash
REGION=us-east-1 DAYS=90 ./scripts/set-log-retention.sh   # AgentCore makes its own log groups
REGION=us-east-1 ./scripts/enable-ecr-scanning.sh         # registry-wide ECR scan-on-push
```

## Local vs. worker GitHub auth

| Context | Who | Auth |
|---------|-----|------|
| Repo picker (`/cloud-mode-repo`) | You, locally | your existing `gh` login |
| Push + PR / direct-merge | AgentCore worker | GitHub App installation token (Secrets Manager) |

### Access model — IAM ⇒ GitHub (read this in shared AWS accounts)

The worker trusts the invoke payload: whoever can call
`bedrock-agentcore:InvokeAgentRuntime` on the runtime chooses the target repo
per invocation. That means **an AWS permission is transitively GitHub write
access**: any principal with invoke permission on this runtime can make agents
push branches / open PRs (or, in `direct-merge` projects, land commits) on
**every repo the GitHub App is installed on**.

You own both sides of that boundary — keep them aligned:

- **Scope the GitHub App installation per-repo — this is a requirement, not a
  preference.** Install with **"Only select repositories"** and list only the
  repos Cloud Mode may write to. The installation *is* the repo allow-list, and
  GitHub is the only thing that enforces it. An org-wide ("All
  repositories") installation is not a supported configuration: it makes every
  threat in this system org-scoped — one prompt injection or one leaked
  credential then reaches every repository in the org. The extension
  warns once per session when it detects that scope; the warning is not a
  substitute for fixing it.
- **Grant `InvokeAgentRuntime` narrowly.** Only principals who should be able
  to write those repos may hold it (see the `OperatorRoleArn` output). In a
  personal account this is just you; in a shared account, treat the grant like
  a repo write grant.
- **What a compromised session can reach.** Because of the credential and uid
  split (see [Isolation inside the session](#isolation-inside-the-session)), code
  execution inside a session does not reach the GitHub App private key or the
  installation token; it reaches an unprivileged user with the checked-out
  worktree and a Bedrock-only credential. The App installation scope remains the
  outer boundary.

## Security considerations

Read this before deploying anything. The boundaries it summarises are
described in detail in [`docs/agent-isolation.md`](docs/agent-isolation.md).

**1. The isolation model is illustrative and has not been adversarially tested.**
[Isolation inside the session](#isolation-inside-the-session) describes a bespoke
containment pattern — an environment allow-list, a second OS user entered via
`setpriv` / `runuser` / `sudo`, a loopback credential broker, and a fail-closed
switch (`CLOUD_MODE_REQUIRE_UID_SANDBOX=1`). It is demo-grade by intent: it is
reasoned about and asserted by tests, but it has **not** been red-teamed, and no
scanner in this repo's gate speaks to it. Treat a uid split inside one container
as defence in depth, **not** as a security boundary against determined,
attacker-influenced code.

**2. A production deployment needs its own security review of that boundary**, and
should prefer platform isolation over this repo's in-container pattern:

| Weaker-by-design choice here | Production alternative |
|---|---|
| Untrusted code and the orchestrator share one container, separated by uid | One workload per sandbox at the platform layer: a separate AgentCore session/microVM (or ECS/Fargate task, or Firecracker/gVisor sandbox) per untrusted step, with no orchestrator secret in the same kernel namespace |
| Privilege drop via `setpriv`/`runuser` from a root orchestrator (AgentCore forbids setuid) | Non-root containers with a read-only root filesystem, dropped Linux capabilities, `seccomp`/AppArmor profiles, and user namespaces |
| Env scrubbing by allow-list before exec | Never materialise secrets in the process tree at all: short-lived, audience-scoped tokens fetched per operation from a broker outside the sandbox |
| Loopback credential broker with a shared secret compared via `timingSafeEqual` | Platform-issued workload identity (IRSA / AgentCore workload identity) so no bearer secret exists to steal |
| Path containment enforced in the agent's file tools | Filesystem isolation by mount namespace: only the worktree is visible to the sandbox |
| Restricted egress via a Network Firewall domain allow-list | The same, plus per-destination authentication and egress logging as a monitored control, reviewed against your own data-exfiltration model |
| Prompt-injection defences are advisory (sanitised event text, redacted transcripts) | Assume injection succeeds and make every downstream action independently authorised and reviewable |
| Model-authored commits landing without human review (`direct-merge`) | `pull-request` with required reviewers and required status checks — the default here, and the only mode we recommend |

**3. An AWS invoke permission carries GitHub write access.** Anyone who can call
`bedrock-agentcore:InvokeAgentRuntime` on this runtime can make an agent push
branches, open PRs, or (in `direct-merge` projects) land commits on **every**
repository the GitHub App is installed on — see [Access model — IAM ⇒
GitHub](#access-model--iam--github). Grant that IAM permission exactly as
carefully as you would grant repository write access, and keep the App
installation scoped to "Only select repositories" so the two sides stay aligned.

Also worth knowing before you deploy:

- The default model is a **cross-region inference profile**
  (`global.anthropic.claude-opus-5`), so requests may be served from a region
  other than the one you deploy into. If data residency matters, pin a
  region-specific model id.
- `scripts/set-data-retention.sh` and the Bedrock data-handling trade-offs are
  described under [Your data and service
  improvement](#your-data-and-service-improvement) — read it before running that
  script.
- Story text, repository contents, and CI output all reach the model, and the
  agent is assumed to be attacker-influenceable by construction.

## Offline demo

`/cloud-mode-demo` launches a scripted three-agent scenario through the real
live pipeline (widget + overlay) with no AWS or network involved — useful for
exploring the UI before deploying anything. `/cloud-mode-demo fast` runs it at
higher speed.

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — compute model, worker
  contract, delivery pipeline, extension and CDK stack.
- [`docs/agent-isolation.md`](docs/agent-isolation.md) — trust boundaries inside
  a worker session.
- [`docs/event-streaming.md`](docs/event-streaming.md) — sequenced events and the
  resilient watch.
- [`docs/architecture.html`](docs/architecture.html) — rendered diagrams.

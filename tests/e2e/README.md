# Cloud Mode — end-to-end test (AWS AgentCore path)

Drives the **real** Cloud Mode transport (`.pi/extensions/cloud-mode/agentcore.ts`
+ `sse.ts`) against the **deployed** Bedrock AgentCore runtime and the live
worker container. There is **no** fake worker and **no** local seam — this is
the AWS path only.

It invokes the runtime for a fresh story and asserts the worker completes the
full lifecycle: authenticate → clone → solve (pi agent on Bedrock) → push →
open a pull request.

## Prerequisites

- The stack is deployed (`cd cdk && npx cdk deploy`) and `.pi/cloud-mode.json`
  points at the resulting `agentRuntimeArn`.
- GitHub App secrets are populated in Secrets Manager (see repo README).
- Bedrock model access is enabled for the configured model in the region.
- Local AWS credentials can `bedrock-agentcore:InvokeAgentRuntime`.
- `gh` CLI is logged in (used only for post-test PR cleanup).

## Run

```bash
bash tests/e2e/run-e2e.sh
```

Reads coordinates from `.pi/cloud-mode.json` (region, agentRuntimeArn,
qualifier) and the target repo from `.pi/cloud-mode.state.json`. Override with
`CLOUD_MODE_*` / `E2E_*` env vars (see `run-e2e.sh`).

Expected tail:

```
PASS: received worker status events
PASS: stream reached cloud_done
PASS: worker finished without error
PASS: a pull request was opened
E2E RESULT: PASS
```

The script closes the PR and deletes the branch it created as a best-effort
cleanup so the selftest repo doesn't accumulate open PRs.

## Files

- `run-e2e.sh` — orchestrates the run, resolves config, invokes the driver,
  cleans up the PR afterwards.
- `aws-e2e.mjs` — imports the extension's real `invokeAgentRuntime` and streams a
  live story to completion, asserting the lifecycle events + PR link.

## Bugs this test caught (and that were fixed)

Building and running this against real AWS surfaced four real defects:

1. **CDK**: the AgentCore `Runtime` was created in parallel with the runtime
   role's IAM policy, so ECR-access validation failed
   (`Access denied while validating ECR URI`). Fixed with an explicit
   `runtime.node.addDependency(runtimeRole)`.
2. **CDK**: an AgentCore runtime auto-provisions its own `DEFAULT` endpoint, so
   creating a `CfnRuntimeEndpoint` named `DEFAULT` failed with 409
   `AlreadyExists`. Removed the redundant endpoint resource.
3. **Worker image**: the `Dockerfile` didn't `COPY secrets.mjs`, so the
   container crash-looped with `ERR_MODULE_NOT_FOUND`.
4. **Worker/Bedrock auth**: AgentCore injects only `AWS_REGION` (no credential
   env vars). pi's `amazon-bedrock` provider gates on a known AWS credential env
   var before calling Bedrock, so it threw *"No API key found for
   amazon-bedrock"*. Fixed by resolving the ambient runtime-role credentials via
   the AWS SDK provider chain and exporting them as env vars before each run.

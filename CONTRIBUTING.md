# Development & Operations

## Deployed environment (your account)

The stack deploys into **your own** AWS account and region — e.g.
**`aws://123456789012/us-east-1`** (`123456789012` is a placeholder; never commit
a real account id). Key outputs (mirrored into the local, git-ignored
`.pi/cloud-mode.json`):

| Output | Value |
|--------|-------|
| Agent runtime ARN | `AgentRuntimeArn` (paste into `.pi/cloud-mode.json`) |
| Runtime endpoint | `DEFAULT` |
| Runtime role | `RuntimeRoleArn` |
| Operator role | `OperatorRoleArn` |

Re-print anytime:

```bash
aws cloudformation describe-stacks --stack-name CloudModeStack \
  --query "Stacks[0].Outputs" --output table
```

## Remaining manual steps (cannot be automated)

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps):
   - Permissions: `Contents: Read & write`, `Pull requests: Read & write`
   - Install it on **only the specific repositories** Cloud Mode may write to —
     "All repositories" is not a supported configuration (see the README's
     Security considerations)
   - Note the **App ID** + **Installation ID**, generate a **private key** (`.pem`)
2. **Populate secrets** (GitHub App creds; the LLM uses Bedrock via the runtime role, no key):
   ```bash
   GH_APP_ID=... GH_INSTALLATION_ID=... \
   GH_PRIVATE_KEY_FILE=./god-agent.private-key.pem \
   REGION=us-east-1 \
   ./scripts/put-secrets.sh
   ```
3. In pi: `/cloud-mode-repo` → pick a repo → delegate a story → `/cloud-mode`.

## Type-checking the extension

```bash
cd .pi/extensions/cloud-mode
npm install
npx tsc -p tsconfig.json   # noEmit, strict
```

(The `@earendil-works/*` and `typebox` types resolve from pi's own install at
runtime via jiti; for standalone editor/tsc checks symlink them into
`node_modules/` or run inside a project where pi is installed.)

## CDK

```bash
cd cdk
npm install
npx cdk diff
npx cdk deploy --require-approval never
npx cdk destroy            # tear everything down (stops recurring cost)
```

## Cost note

AgentCore Runtime is **serverless** and session-scoped: you pay only while a
delegated agent is actively running an invoke (no idle cluster, no NAT gateway).
Use `/cloud-mode-stop` to end a runaway agent, and `cdk destroy` to remove the
runtime + roles + secrets entirely.

## Security-control checklist (required for every change that touches a control)

`docs/agent-isolation.md` and the README make claims about this code, and
every one of those claims is enforced by source that keeps changing. A
control without a test is a comment. So:

- [ ] **Ship a test that fails if the control is removed.** Not a test that the
      happy path works — a test that asserts the *denial*: the payload is
      rejected, the push is refused, the path is confined, the secret is masked.
- [ ] **Add a SAST rule when the control class is statically detectable.**
      `scripts/sast-rules.yml` already covers shell/dynamic-code injection,
      hardcoded or logged secrets, `Math.random()` for tokens, timing-unsafe
      comparison, TLS downgrade, non-loopback plaintext HTTP and wildcard IAM
      resources. If your control introduces a new "never write this again"
      pattern, encode it there — and extend `tests/static-analysis.test.mjs`, so
      the rule itself cannot decay into a no-op.
- [ ] **Update `docs/agent-isolation.md` in the same change** if the boundary,
      what it holds, or what it does not cover has changed. Documentation that
      overclaims is worse than none, because it stops people looking.
- [ ] **Keep defaults safe.** If a control can be turned off, the off-switch is
      an explicit opt-out (`CLOUD_MODE_*=0`), never the default, and its use is
      reported at delivery time.
- [ ] **`npm run verify` is green** (unit tests + CDK invariants + SAST).

### Recurring hygiene (not fixable once, so it is scheduled)

| What | Where | Cadence |
|------|-------|---------|
| Dependency advisories (`npm audit`, OSV) | `.github/workflows/audit.yml` | weekly + on PR |
| Base-image digest drift / Debian CVEs | `.github/workflows/base-image-refresh.yml` | monthly |
| ECR scan-on-push findings | `scripts/enable-ecr-scanning.sh` | every image push |

A red run on any of these is a review task, not noise: dependency and
base-image drift cannot be fixed once and are managed by this schedule.

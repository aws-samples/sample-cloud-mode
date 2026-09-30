#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Cloud Mode — one-time infrastructure provisioning.
#
# Everything else (config, GitHub App, secrets, repo selection) is handled
# INTERACTIVELY inside pi by the /cloud-mode-setup wizard. This script only
# covers the part that belongs in a real terminal: the long-running CDK
# deploy (Docker image build + AgentCore runtime + roles + secret shells)
# and the extension's npm install (needed before the extension can load).
#
# Usage:
#   ./scripts/setup.sh
#
# Env overrides:
#   REGION            AWS region for the stack (default: eu-central-1)
#   SKIP_DEPLOY=1     skip `cdk deploy` (stack already deployed)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
die()   { fail "$*"; echo; echo "Fix the issue above and re-run ./scripts/setup.sh"; exit 1; }

# ── 0. What you're signing up for ─────────────────────────────────────────────
bold "Pi Cloud Mode — infrastructure setup"
cat <<'EOF'

  Cloud Mode delegates user stories to isolated cloud sub-agents that open
  pull requests on your behalf.

  ⚠️  Current restrictions — please read:
    • GitHub only  — target repos must live on github.com. Pull requests are
      opened via a GitHub App. GitLab/Bitbucket/etc. are NOT supported.
    • AWS only     — sub-agents run on Amazon Bedrock AgentCore and use
      Bedrock-hosted Claude models. You need an AWS account with Bedrock
      model access enabled in your chosen region. Other clouds/LLM
      providers are NOT supported.
    • 💰 Cost      — every delegated story starts a billable AgentCore
      session and consumes Bedrock tokens. A confirmation gate and a
      concurrency cap (maxConcurrentAgents) are built in.

EOF
read -r -p "Continue? [Y/n] " reply
[[ "${reply:-y}" =~ ^[Yy]?$ ]] || exit 0
echo

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
bold "1/3 Checking prerequisites"

command -v node >/dev/null 2>&1 || die "node not found — install Node.js 20+ (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node -v))"
ok "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm not found"
ok "npm $(npm -v)"

command -v docker >/dev/null 2>&1 || die "docker not found — needed to build the worker image for CDK"
docker info >/dev/null 2>&1 || die "docker daemon not running — start Docker and re-run"
ok "docker running"

command -v aws >/dev/null 2>&1 || die "aws CLI not found — install it and run 'aws configure'"
AWS_IDENTITY="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null)" \
  || die "AWS credentials not working — run 'aws configure' (or set AWS_PROFILE) and re-run"
ok "aws credentials: ${AWS_IDENTITY}"
echo

# ── 2. Deploy infrastructure ─────────────────────────────────────────────────
bold "2/3 Deploying AWS infrastructure (CDK)"

REGION="${REGION:-eu-central-1}"
read -r -p "AWS region for the AgentCore runtime [${REGION}]: " r
REGION="${r:-$REGION}"

# ── Validation gate (safety) ─────────────────────────────────────────────────
# The integration loop rebases each agent's work onto the latest default branch
# and can auto-resolve conflicts before pushing. To make that safe, it runs a
# VALIDATION COMMAND on the resulting tree and refuses to push if it fails.
# This is the guard that stops a bad auto-resolution (or a broken change) from
# landing on your default branch. If you leave it empty the gate is DISABLED
# (every resolved tree is pushed) — strongly discouraged for direct-merge repos.
cat <<'EOF'

  Validation gate (recommended):
    A shell command run inside the cloned repo BEFORE each push to the default
    branch. A non-zero exit blocks the push, so broken code / bad conflict
    resolutions never land. Leave empty to DISABLE the gate (not recommended).

    Examples:
      npm ci && npm run lint && npm test
      npm run typecheck && npm test
      make check
EOF
DEFAULT_VALIDATE_CMD="${CLOUD_MODE_VALIDATE_CMD:-}"
read -r -p "Validation command [${DEFAULT_VALIDATE_CMD:-<none — gate disabled>}]: " vc
export CLOUD_MODE_VALIDATE_CMD="${vc:-$DEFAULT_VALIDATE_CMD}"
if [ -n "${CLOUD_MODE_VALIDATE_CMD}" ]; then
  ok "validation gate: ${CLOUD_MODE_VALIDATE_CMD}"
else
  warn "validation gate DISABLED — resolved trees will be pushed without checks"
fi

if [ "${SKIP_DEPLOY:-0}" = "1" ]; then
  warn "SKIP_DEPLOY=1 — skipping cdk deploy"
else
  (
    cd cdk
    npm install --silent
    export CDK_DEFAULT_REGION="$REGION"
    npx cdk bootstrap 2>/dev/null || true
    npx cdk deploy --require-approval never
  )
  ok "CloudModeStack deployed to ${REGION}"
fi
echo

# ── 3. Extension dependencies ────────────────────────────────────────────────
bold "3/3 Installing extension dependencies"
( cd .pi/extensions/cloud-mode && npm install --silent )
ok "extension dependencies installed"
echo

bold "✅ Infrastructure ready"
cat <<EOF

  Finish setup inside pi — the interactive wizard handles the rest
  (config file, GitHub App + secrets, target repo):

    1. Start pi in this project and trust it when asked.
    2. Run /cloud-mode-setup and follow the prompts.

  Also make sure Bedrock model access is enabled for your Claude model in
  ${REGION} (AWS console → Bedrock → Model access). If invocations fail with
  a data-retention ValidationException, run:
    REGION=${REGION} ./scripts/set-data-retention.sh

  Validation gate is currently: ${CLOUD_MODE_VALIDATE_CMD:-DISABLED}
  To set or change it later, re-run setup with the command exported, e.g.:
    CLOUD_MODE_VALIDATE_CMD="npm ci && npm test" REGION=${REGION} ./scripts/setup.sh

  Remember: GitHub + AWS only. Every delegated story is billable.
EOF

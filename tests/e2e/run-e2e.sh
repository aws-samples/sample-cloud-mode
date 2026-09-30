#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# End-to-end test for Cloud Mode against the DEPLOYED Bedrock AgentCore runtime.
#
# Drives the extension's real transport (agentcore.ts + sse.ts) against the live
# worker container: it invokes the runtime for a fresh story and asserts the
# worker clones the repo, solves the story, and opens a pull request. There is
# no fake worker and no local seam — this is the AWS path only.
#
# Reads AgentCore coordinates from .pi/cloud-mode.json (region, agentRuntimeArn,
# qualifier) and the target repo from .pi/cloud-mode.state.json, unless
# overridden by CLOUD_MODE_* / E2E_* env vars.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
CFG="$REPO_ROOT/.pi/cloud-mode.json"
STATE="$REPO_ROOT/.pi/cloud-mode.state.json"

jval() { node -e "process.stdout.write(String((require('$1')||{})$2 ?? ''))" 2>/dev/null; }

export CLOUD_MODE_REGION="${CLOUD_MODE_REGION:-$(jval "$CFG" .region)}"
export CLOUD_MODE_RUNTIME_ARN="${CLOUD_MODE_RUNTIME_ARN:-$(jval "$CFG" .agentRuntimeArn)}"
export CLOUD_MODE_QUALIFIER="${CLOUD_MODE_QUALIFIER:-$(jval "$CFG" .qualifier)}"
export E2E_REPO_URL="${E2E_REPO_URL:-$(jval "$STATE" .repo.url)}"
export E2E_REPO_NWO="${E2E_REPO_NWO:-$(jval "$STATE" .repo.nameWithOwner)}"
export E2E_BASE_BRANCH="${E2E_BASE_BRANCH:-$(jval "$STATE" .repo.defaultBranch)}"
export E2E_STORY_ID="${E2E_STORY_ID:-e2e-$(date +%s)}"

echo "region     : $CLOUD_MODE_REGION"
echo "runtimeArn : $CLOUD_MODE_RUNTIME_ARN"
echo "repo       : $E2E_REPO_NWO (base $E2E_BASE_BRANCH)"
echo

if [[ -z "$CLOUD_MODE_RUNTIME_ARN" || "$CLOUD_MODE_RUNTIME_ARN" == *REPLACE* ]]; then
	echo "FAIL: agentRuntimeArn not configured (deploy the stack, update .pi/cloud-mode.json)"
	exit 2
fi

node --experimental-strip-types "$HERE/aws-e2e.mjs"
RC=$?

# Best-effort cleanup: close the PR + delete the branch this run created, so the
# selftest repo doesn't accumulate open PRs. Requires gh; ignore failures.
BRANCH="feature/${E2E_STORY_ID}"
if command -v gh >/dev/null 2>&1; then
	echo
	echo "== cleanup: closing PRs for branch $BRANCH =="
	gh pr close "$BRANCH" --repo "$E2E_REPO_NWO" --delete-branch 2>/dev/null \
		&& echo "  closed PR + deleted $BRANCH" \
		|| echo "  (nothing to close, or manual cleanup needed)"
fi

exit $RC

#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Container-level verification of the OUT-OF-PROCESS AGENT boundary.
#
# `tests/agent-isolation.test.mjs` proves the policy on the host; this proves the
# real thing in the real image, where the uid boundary actually exists:
#
#   1. the agent child really starts under the unprivileged user (not root);
#   2. the child cannot read the orchestrator's environment via /proc — the
#      historical path to the GitHub token;
#   3. the child cannot read the orchestrator's token store or the clone's .git;
#   4. no AWS_*/GH_*/CLOUD_MODE_* variable crosses into the child, so the
#      credential broker's coordinates are out of reach;
#   5. the loopback model proxy refuses a request without the capability and
#      refuses a model other than the pinned one, even with it;
#   6. the whole agent-host module loads and drops privilege inside the image
#      (i.e. the `setpriv` path used for the agent is the audited one).
#
# Deliberately does NOT need AWS or a GitHub App: it stubs the model proxy and
# runs a tiny child instead of a full pi session, because what is under test is
# the BOUNDARY, not the agent's behaviour.
#
# Usage: tests/agent-isolation-container.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${CLOUD_MODE_TEST_IMAGE:-cloud-mode-worker-agent-test:local}"

echo "== building worker image (arm64) =="
if ! docker build --platform linux/arm64 -t "$IMAGE" "$REPO_ROOT/worker" >/dev/null; then
	echo "FAIL: image build"
	exit 1
fi

echo "== running in-container agent-boundary assertions =="
docker run --rm --platform linux/arm64 \
	-v "$HERE/agent-isolation-container-assertions.mjs:/tmp/agent-assertions.mjs:ro" \
	-e AWS_ACCESS_KEY_ID=ASIALEAKCANARY \
	-e AWS_SECRET_ACCESS_KEY=secretleakcanary \
	-e AWS_SESSION_TOKEN=sessionleakcanary \
	-e AWS_CONTAINER_AUTHORIZATION_TOKEN=brokerleakcanary \
	-e GH_TOKEN=ghs_leakcanary \
	-e CLOUD_MODE_GIT_TOKEN=ghs_leakcanary2 \
	-e CLOUD_MODE_AGENT_OUT_OF_PROCESS=1 \
	-e PI_MODEL=global.anthropic.claude-opus-5 \
	--entrypoint /usr/local/bin/node "$IMAGE" /tmp/agent-assertions.mjs
status=$?
if [ $status -eq 0 ]; then
	echo "== PASS: out-of-process agent boundary verified in the image =="
else
	echo "== FAIL: see output above =="
fi
exit $status

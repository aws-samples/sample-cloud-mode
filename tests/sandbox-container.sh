#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
#
# Container-level verification of the untrusted-execution isolation (rungs 1-3).
#
# Builds the worker image LOCALLY and asserts, inside the container, that:
#   1. the orchestrator user can drop to the unprivileged user (sudo rule works);
#   2. the orchestrator's token store and environment are unreachable from it;
#   3. untrusted code can write the worktree but not the clone's .git / hooks;
#   4. the orchestrator can still commit what untrusted code produced;
#   5. the validation gate runs as the unprivileged user, credential-free;
#   6. pi's Bedrock provider gate is satisfied with NO credential in the env.
#
# Touches no AWS account and no deployed stack. Usage: tests/sandbox-container.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${CLOUD_MODE_TEST_IMAGE:-cloud-mode-worker-sandbox-test:local}"

echo "== building worker image (arm64) =="
if ! docker build --platform linux/arm64 -t "$IMAGE" "$REPO_ROOT/worker" >/dev/null; then
	echo "FAIL: image build"
	exit 1
fi

echo "== running in-container assertions =="
docker run --rm --platform linux/arm64 \
	-v "$HERE/sandbox-container-assertions.mjs:/tmp/assertions.mjs:ro" \
	-e CLOUD_MODE_VALIDATE_CMD='id -un; echo "gh=${GH_TOKEN:-none}"; echo "aws=${AWS_SECRET_ACCESS_KEY:-none}"' \
	-e AWS_ACCESS_KEY_ID=ASIALEAKCANARY \
	-e AWS_SECRET_ACCESS_KEY=secretleakcanary \
	-e GH_TOKEN=ghs_leakcanary \
	--entrypoint /bin/bash "$IMAGE" -euo pipefail -c '
fail() { echo "FAIL: $1"; exit 1; }
ok()   { echo "ok: $1"; }

# The orchestrator runs as root so it can drop privileges (AgentCore blocks
# setuid, so a non-root process cannot switch users).
ok "orchestrator runs as $(id -un)"

drop() { setpriv --reuid=cmagent --regid=cmwork --clear-groups -- "$@"; }
[ "$(drop /usr/bin/id -un)" = cmagent ] || fail "cannot drop privileges to cmagent with setpriv"
ok "setpriv drop to cmagent works (no setuid required)"

# The askpass helper lives in the orchestrator home dir; the token itself only
# ever exists in the orchestrator environment.
mkdir -p ~/.cloud-mode && chmod 700 ~/.cloud-mode
printf "#!/bin/sh\nprintf %%s \"\$CLOUD_MODE_GIT_TOKEN\"\n" > ~/.cloud-mode/askpass.sh
chmod 700 ~/.cloud-mode/askpass.sh
if drop /bin/cat "$HOME/.cloud-mode/askpass.sh" >/dev/null 2>&1; then
  fail "orchestrator credential directory readable by cmagent"
fi
ok "orchestrator credential directory unreadable by cmagent"

if drop /bin/sh -c "cat /proc/1/environ" 2>/dev/null | tr "\0" "\n" | grep -q secretleakcanary; then
  fail "cmagent read the orchestrator environment via /proc"
fi
ok "orchestrator /proc environ unreadable by cmagent"

node /tmp/assertions.mjs
'
status=$?
if [ $status -eq 0 ]; then
	echo "== PASS: container isolation verified =="
else
	echo "== FAIL: see output above =="
fi
exit $status

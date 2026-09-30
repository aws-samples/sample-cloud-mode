#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

#
# Static analysis of THIS project's own source.
#
# Why it lives in the build and not in a pipeline: Cloud Mode is an extension to
# an existing coding agent, shipped as source and built by whoever deploys it.
# There is no service pipeline to gate, so the build/test entry point is the only
# place a check is genuinely unavoidable — `npm run verify` runs typecheck, unit
# tests, infra assertions AND this scan, and blocks on the same terms.
#
# Coverage (see scripts/sast-rules.yml for the rules):
#   • injection        — shell commands / dynamic code built from interpolation
#   • secrets          — credentials hardcoded in source or logged
#   • crypto           — weak randomness for tokens, timing-unsafe comparisons
#   • transport        — disabled TLS verification, non-loopback plaintext http
#   • infrastructure   — wildcard IAM actions (blocking) / resources (advisory)
#   • shell scripts    — shellcheck, when available
#
# Severity contract (per the SAST guidance): ERROR blocks, WARNING is reported
# but never blocks. Triage a false positive at the call site with
# `nosemgrep: <rule-id>` and a one-line reason.
#
# Usage:
#   ./scripts/static-analysis.sh              # blocking scan + advisory report
#   ALLOW_NO_SAST=1 ./scripts/...             # skip if no analyzer is installed
#   SAST_REGISTRY=1 ./scripts/...             # add semgrep registry rulesets
#
# Fails closed: with no analyzer available the scan is NOT silently skipped —
# a skipped gate is not a passing gate.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RULES="scripts/sast-rules.yml"
TARGETS=(".pi/extensions/cloud-mode" "cdk" "worker" "scripts" "tests")

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

bold "Static analysis (own source)"

# ── Locate an analyzer ───────────────────────────────────────────────────────
SEMGREP=()
if command -v semgrep >/dev/null 2>&1; then
	SEMGREP=(semgrep)
elif command -v uvx >/dev/null 2>&1; then
	SEMGREP=(uvx semgrep)
elif command -v pipx >/dev/null 2>&1; then
	SEMGREP=(pipx run semgrep)
elif command -v docker >/dev/null 2>&1 && [ "${SAST_ALLOW_EXTERNAL_IMAGE:-}" = "1" ]; then
	# Opt-in only. This pulls semgrep/semgrep from Docker Hub, an external
	# third-party registry, which BuilderHub container guidance disallows for
	# anything that ships (Bosco/ACAT `non-ecr-docker-image`). semgrep is not
	# published on ECR Public, so the Docker path stays behind an explicit flag
	# and is never used by default; prefer `brew install semgrep` / uvx / pipx.
	SEMGREP=(docker run --rm -v "$ROOT:/src" -w /src semgrep/semgrep semgrep)
fi

if [ ${#SEMGREP[@]} -eq 0 ]; then
	if [ "${ALLOW_NO_SAST:-}" = "1" ]; then
		warn "no analyzer found; skipping because ALLOW_NO_SAST=1"
		exit 0
	fi
	fail "no static analyzer found (need semgrep, uvx, pipx or docker)."
	echo "     Install one:  brew install semgrep   |   pipx install semgrep"
	echo "     A skipped gate is not a passing gate; set ALLOW_NO_SAST=1 to override."
	exit 1
fi

CONFIG=(--config "$RULES")
if [ "${SAST_REGISTRY:-}" = "1" ]; then
	# Opt-in: broader community rulesets. Needs network, so never the default.
	CONFIG+=(--config p/javascript --config p/typescript --config p/secrets)
fi

COMMON=(--metrics off --disable-version-check --error)
for t in "${TARGETS[@]}"; do COMMON+=("$t"); done
EXCLUDES=(--exclude node_modules --exclude cdk.out --exclude "*.min.js" --exclude demo)

# ── 1. Blocking pass: ERROR only ─────────────────────────────────────────────
if "${SEMGREP[@]}" "${CONFIG[@]}" "${EXCLUDES[@]}" --severity ERROR "${COMMON[@]}"; then
	ok "no high-severity findings"
	blocking=0
else
	blocking=$?
	fail "high-severity findings above must be fixed or triaged (nosemgrep + reason)"
fi

# ── 2. Advisory pass: everything else, never blocking ────────────────────────
echo
bold "Advisory findings (reported, non-blocking)"
"${SEMGREP[@]}" "${CONFIG[@]}" "${EXCLUDES[@]}" --severity WARNING --severity INFO \
	--metrics off --disable-version-check "${TARGETS[@]}" || true

# ── 3. Shell scripts ─────────────────────────────────────────────────────────
echo
if command -v shellcheck >/dev/null 2>&1; then
	bold "Shell scripts (shellcheck)"
	if shellcheck -S warning scripts/*.sh tests/*.sh; then
		ok "no shellcheck warnings"
	else
		fail "shellcheck warnings above"
		blocking=1
	fi
else
	warn "shellcheck not installed — shell scripts not linted (brew install shellcheck)"
fi

echo
[ "$blocking" -eq 0 ] && ok "static analysis passed" || fail "static analysis FAILED"
exit "$blocking"

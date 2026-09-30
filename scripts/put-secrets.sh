#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#
# Populate the Cloud Mode secrets in AWS Secrets Manager.
# Run AFTER `cdk deploy` and AFTER creating the GitHub App.
#
# Usage:
#   GH_APP_ID=123456 \
#   GH_INSTALLATION_ID=789012 \
#   GH_PRIVATE_KEY_FILE=./cloud-mode-agent.private-key.pem \
#   REGION=us-east-1 \
#   ./scripts/put-secrets.sh
#
# (The LLM uses Amazon Bedrock via the AgentCore runtime role — no key secret.)
set -euo pipefail

: "${GH_APP_ID:?set GH_APP_ID}"
: "${GH_INSTALLATION_ID:?set GH_INSTALLATION_ID}"
: "${GH_PRIVATE_KEY_FILE:?set GH_PRIVATE_KEY_FILE (path to .pem)}"
: "${REGION:=us-east-1}"

put() {
  aws secretsmanager put-secret-value \
    --region "$REGION" \
    --secret-id "$1" \
    --secret-string "$2" >/dev/null
  echo "  ✓ $1"
}

echo "Writing secrets to region ${REGION}…"
put "cloud-mode/gh-app-id"          "$GH_APP_ID"
put "cloud-mode/gh-installation-id" "$GH_INSTALLATION_ID"
put "cloud-mode/gh-app-private-key" "$(cat "$GH_PRIVATE_KEY_FILE")"
echo "Done. The AgentCore worker can now authenticate."

#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Apply a retention policy to the Cloud Mode worker's CloudWatch log groups.
#
# AgentCore creates the runtime's log groups itself, so retention cannot be set
# in the CDK stack — this script applies it after deploy (idempotent; safe to
# re-run). Transcripts may quote proprietary code, so unbounded retention is a
# confidentiality risk, not just a cost one.
#
# Usage: REGION=us-east-1 DAYS=90 ./scripts/set-log-retention.sh
set -euo pipefail
REGION="${REGION:-${AWS_REGION:-us-east-1}}"
DAYS="${DAYS:-90}"
PREFIXES=("/aws/bedrock-agentcore" "/cloud-mode")

for prefix in "${PREFIXES[@]}"; do
  groups=$(aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "$prefix" --query 'logGroups[].logGroupName' --output text || true)
  for g in $groups; do
    echo "retention ${DAYS}d -> $g"
    aws logs put-retention-policy --region "$REGION" --log-group-name "$g" --retention-in-days "$DAYS"
  done
done
echo "done."

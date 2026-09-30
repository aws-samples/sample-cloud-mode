#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Enable ECR scan-on-push for the CDK asset repository that holds the Cloud Mode
# worker image.
#
# The image is published to the shared CDK bootstrap asset repo, which the stack
# does not own, so scanning is configured at the registry level here.
#
# Usage: REGION=us-east-1 ./scripts/enable-ecr-scanning.sh
set -euo pipefail
REGION="${REGION:-${AWS_REGION:-us-east-1}}"

echo "== enabling registry scan-on-push (BASIC) in $REGION"
aws ecr put-registry-scanning-configuration --region "$REGION" \
  --scan-type BASIC \
  --rules '[{"scanFrequency":"SCAN_ON_PUSH","repositoryFilters":[{"filter":"*","filterType":"WILDCARD"}]}]' \
  >/dev/null
echo "== current findings for the newest worker image"
repo=$(aws ecr describe-repositories --region "$REGION" \
  --query 'repositories[?contains(repositoryName,`container-assets`)].repositoryName | [0]' --output text)
if [ "$repo" != "None" ] && [ -n "$repo" ]; then
  digest=$(aws ecr describe-images --region "$REGION" --repository-name "$repo" \
    --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageDigest' --output text)
  aws ecr describe-image-scan-findings --region "$REGION" --repository-name "$repo" \
    --image-id imageDigest="$digest" \
    --query 'imageScanFindings.findingSeverityCounts' --output json 2>/dev/null \
    || echo "(scan not complete yet — re-run in a minute)"
fi

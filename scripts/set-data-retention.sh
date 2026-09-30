#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

#
# Set the account-wide Bedrock data retention mode.
#
# Some newer Bedrock models (e.g. the "fable" family) reject the account's
# `default` data retention mode and fail with a 400 ValidationException:
#
#   The model returned the following errors:
#   data retention mode 'default' is not available for this model
#
# Setting the mode to `provider_data_share` opts the account into the provider
# data-share retention mode those models require. This is an ACCOUNT-WIDE,
# per-region setting — it affects every Bedrock call in the account/region, not
# just Cloud Mode. Run it once per region you invoke Bedrock from.
#
# The DEFAULT MODE of this script is the narrower `aws_review`, which keeps
# content from the model provider. Only pass MODE=provider_data_share when a
# model you have deliberately chosen requires it, and only after the review
# below. Bedrock also offers per-project data-retention scope (Bedrock
# Projects) — prefer scoping the decision to a project over an account-wide
# opt-in where that fits your setup.
#
# ⚠️  DATA-HANDLING DECISION, NOT JUST AN OPERATIONAL FIX
# `provider_data_share` opts the ACCOUNT into sharing content with the model
# provider. Review it against your organization's data-handling rules and your
# AWS AI services opt-out policy before running it — that policy (set at the
# AWS Organizations level, enforced by Bedrock) is what governs whether content
# processed by an AI service may be used to improve that service:
#   https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_ai-opt-out.html
# Prefer choosing a model that works with your existing retention mode.
#
# The AWS CLI SigV4-signs this with your ambient creds/profile (same auth path
# as the rest of Cloud Mode), so no bearer token is needed.
#
# Usage:
#   REGION=us-east-1 ./scripts/set-data-retention.sh                      # aws_review (default)
#   MODE=provider_data_share REGION=us-east-1 ./scripts/set-data-retention.sh  # broadest opt-in
#
# See: https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html
set -euo pipefail

: "${REGION:=us-east-1}"
# One of: default | none | aws_review | provider_data_share | inherit
# Narrow by default: `aws_review` keeps content from the model provider.
: "${MODE:=aws_review}"

if [ "$MODE" = "provider_data_share" ]; then
	echo "WARNING: '${MODE}' is an ACCOUNT-WIDE opt-in to sharing content with the model" >&2
	echo "         provider in ${REGION}. It affects every Bedrock call in this account," >&2
	echo "         not just Cloud Mode. Service-improvement processing is governed by your" >&2
	echo "         AWS AI services opt-out policy (AWS Organizations), not by this script." >&2
	if [ -t 0 ] && [ "${ASSUME_YES:-}" != "1" ]; then
		printf 'Continue? [y/N] ' >&2
		read -r reply
		case "$reply" in
			y | Y | yes | YES) ;;
			*)
				echo "Aborted." >&2
				exit 1
				;;
		esac
	fi
fi

echo "Current data retention mode (${REGION}):"
aws bedrock get-account-data-retention --region "$REGION" || true

echo "Setting data retention mode to '${MODE}' in ${REGION}..."
aws bedrock put-account-data-retention --mode "$MODE" --region "$REGION"

echo "Done. New data retention mode:"
aws bedrock get-account-data-retention --region "$REGION"

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { App } from "aws-cdk-lib";
import { CloudModeStack } from "../cloud-mode-stack.ts";

const app = new App();

// A live deployment must never be touched by an experiment: set
// CLOUD_MODE_STACK_NAME (and CLOUD_MODE_RESOURCE_SUFFIX, which renames the
// globally-unique resources — secrets, runtime, firewall) to deploy an isolated
// test stack beside it, e.g.
//   CLOUD_MODE_STACK_NAME=CloudModeStackIsoTest \
//   CLOUD_MODE_RESOURCE_SUFFIX=isotest npx cdk deploy
const stackName = process.env.CLOUD_MODE_STACK_NAME ?? "CloudModeStack";
const resourceSuffix = process.env.CLOUD_MODE_RESOURCE_SUFFIX ?? "";

const flag = (name: string, fallback: boolean) => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return /^(1|true|yes)$/i.test(raw);
};

new CloudModeStack(app, stackName, {
	env: {
		account: process.env.CDK_DEFAULT_ACCOUNT,
		region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
	},
	provider: process.env.CLOUD_MODE_PROVIDER,
	model: process.env.CLOUD_MODE_MODEL,
	validateCmd: process.env.CLOUD_MODE_VALIDATE_CMD,
	resourceSuffix,
	// Worker egress restriction (VPC + Network
	// Firewall domain allow-list) is ON BY DEFAULT — prompt injection is assumed
	// to succeed, so open egress means an injected agent can exfiltrate the
	// worktree anywhere. It costs NAT + firewall money; opt out deliberately with
	// CLOUD_MODE_RESTRICT_EGRESS=0.
	restrictEgress: flag("CLOUD_MODE_RESTRICT_EGRESS", true),
	extraEgressDomains: (process.env.CLOUD_MODE_EXTRA_EGRESS_DOMAINS ?? "")
		.split(",")
		.map((d) => d.trim())
		.filter(Boolean),
	// A Bedrock-only agent role for the model traffic
	// (default) and hard failure when a boundary cannot be established.
	scopedAgentRole: flag("CLOUD_MODE_SCOPED_AGENT_ROLE", true),
	requireIsolation: flag("CLOUD_MODE_REQUIRE_ISOLATION", true),
	// Real operator principal instead of the placeholder trust policy.
	operatorPrincipalArn: process.env.CLOUD_MODE_OPERATOR_PRINCIPAL_ARN,
	// Durable transcript artifact per session (forensics after a bad merge).
	transcriptArchive: flag("CLOUD_MODE_TRANSCRIPT_ARCHIVE", true),
	transcriptRetentionDays: process.env.CLOUD_MODE_TRANSCRIPT_RETENTION_DAYS
		? Number(process.env.CLOUD_MODE_TRANSCRIPT_RETENTION_DAYS)
		: undefined,
	// Server-side session cap + optional cost visibility.
	maxActiveSessions: process.env.CLOUD_MODE_MAX_ACTIVE_SESSIONS
		? Number(process.env.CLOUD_MODE_MAX_ACTIVE_SESSIONS)
		: undefined,
	monthlyBudgetUsd: process.env.CLOUD_MODE_MONTHLY_BUDGET_USD
		? Number(process.env.CLOUD_MODE_MONTHLY_BUDGET_USD)
		: undefined,
	budgetEmail: process.env.CLOUD_MODE_BUDGET_EMAIL,
});

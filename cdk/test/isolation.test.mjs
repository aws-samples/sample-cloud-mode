// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure assertions for the credential split, plus the guard that lets an isolated TEST stack be
 * deployed beside a live one without colliding on globally-named resources.
 *
 * Synthesis only — nothing here touches an AWS account.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

import { CloudModeStack } from "../cloud-mode-stack.ts";

const ENV = { env: { account: "123456789012", region: "eu-central-1" } };

function synth(props = {}) {
	const app = new App();
	const stack = new CloudModeStack(app, props.stackId ?? "TestStack", { ...ENV, ...props });
	return Template.fromStack(stack);
}

/** All policy documents attached to the role whose description matches. */
function policiesForRole(template, descriptionMatch) {
	const roles = template.findResources("AWS::IAM::Role");
	const logicalIds = Object.entries(roles)
		.filter(([, r]) => descriptionMatch.test(r.Properties?.Description ?? ""))
		.map(([id]) => id);
	assert.equal(logicalIds.length, 1, `expected exactly one role matching ${descriptionMatch}`);
	const roleId = logicalIds[0];
	const inline = roles[roleId].Properties?.Policies ?? [];
	const attached = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
		JSON.stringify(p.Properties?.Roles ?? []).includes(roleId),
	);
	return {
		roleId,
		role: roles[roleId],
		statements: [
			...inline.flatMap((p) => p.PolicyDocument?.Statement ?? []),
			...attached.flatMap((p) => p.Properties?.PolicyDocument?.Statement ?? []),
		],
	};
}

const actionsOf = (statements) => statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

test("agent role may only invoke Bedrock models", () => {
	const template = synth();
	const { statements } = policiesForRole(template, /agent identity/i);
	const actions = actionsOf(statements);
	assert.deepEqual(
		[...new Set(actions)].sort(),
		["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
		"the identity handed to the LLM traffic must do nothing else",
	);
	for (const forbidden of ["secretsmanager:", "ecr:", "logs:", "sts:", "bedrock-agentcore:"]) {
		assert.ok(
			!actions.some((a) => String(a).startsWith(forbidden)),
			`agent role must not be able to call ${forbidden}*`,
		);
	}
});

test("runtime role keeps secret access but loses Bedrock invoke; it can only assume the agent role", () => {
	const template = synth();
	const { statements } = policiesForRole(template, /AgentCore Runtime role/i);
	const actions = actionsOf(statements);
	assert.ok(actions.includes("secretsmanager:GetSecretValue"), "the orchestrator still reads the App key");
	assert.ok(
		!actions.some((a) => String(a).startsWith("bedrock:Invoke")),
		"model traffic must use the scoped agent role, not the runtime role",
	);
	const assumeStatements = statements.filter((s) =>
		(Array.isArray(s.Action) ? s.Action : [s.Action]).includes("sts:AssumeRole"),
	);
	assert.equal(assumeStatements.length, 1);
	assert.ok(!JSON.stringify(assumeStatements[0].Resource).includes("*"), "AssumeRole is scoped to one role ARN");
});

test("runtime is told to fail closed on both boundaries", () => {
	const template = synth();
	const runtimes = Object.values(template.findResources("AWS::BedrockAgentCore::Runtime"));
	assert.equal(runtimes.length, 1);
	const env = runtimes[0].Properties.EnvironmentVariables;
	assert.ok(env.CLOUD_MODE_AGENT_ROLE_ARN, "the worker is told which scoped role to assume");
	assert.equal(env.CLOUD_MODE_REQUIRE_SCOPED_CREDS, "1");
	assert.equal(env.CLOUD_MODE_REQUIRE_UID_SANDBOX, "1");
});

test("opting out reproduces the pre-split posture explicitly", () => {
	const template = synth({ scopedAgentRole: false, requireIsolation: false });
	const roles = Object.values(template.findResources("AWS::IAM::Role"));
	assert.ok(!roles.some((r) => /agent identity/i.test(r.Properties?.Description ?? "")));
	const { statements } = policiesForRole(template, /AgentCore Runtime role/i);
	assert.ok(actionsOf(statements).includes("bedrock:InvokeModel"));
	const env = Object.values(template.findResources("AWS::BedrockAgentCore::Runtime"))[0].Properties
		.EnvironmentVariables;
	assert.equal(env.CLOUD_MODE_AGENT_ROLE_ARN, undefined);
	assert.equal(env.CLOUD_MODE_REQUIRE_SCOPED_CREDS, undefined);
	assert.equal(env.CLOUD_MODE_REQUIRE_UID_SANDBOX, undefined);
});

test("default names are unchanged, so a live stack is not renamed underneath itself", () => {
	const template = synth();
	const secretNames = Object.values(template.findResources("AWS::SecretsManager::Secret")).map(
		(s) => s.Properties.Name,
	);
	assert.deepEqual(secretNames.sort(), [
		"cloud-mode/gh-app-id",
		"cloud-mode/gh-app-private-key",
		"cloud-mode/gh-installation-id",
	]);
	const runtime = Object.values(template.findResources("AWS::BedrockAgentCore::Runtime"))[0];
	assert.equal(runtime.Properties.AgentRuntimeName, "cloud_mode_worker");
});

test("resourceSuffix isolates a test stack from the live one", () => {
	const template = synth({ stackId: "CloudModeStackIsoTest", resourceSuffix: "isotest" });
	const secretNames = Object.values(template.findResources("AWS::SecretsManager::Secret")).map(
		(s) => s.Properties.Name,
	);
	for (const name of secretNames) assert.match(name, /-isotest$/);
	const runtime = Object.values(template.findResources("AWS::BedrockAgentCore::Runtime"))[0];
	assert.equal(runtime.Properties.AgentRuntimeName, "cloud_mode_worker_isotest");
});

// ── No wildcard resources left in the runtime role ────────────────────

test("runtime role has no wildcard-resource statements except the unavoidable ones", () => {
	const template = synth();
	const { statements } = policiesForRole(template, /AgentCore Runtime role/i);
	const wildcards = statements.filter((s) => {
		const res = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
		return res.some((r) => r === "*");
	});
	// ecr:GetAuthorizationToken is account-scoped by the API and cannot take a
	// resource; everything else (logs, workload tokens, secrets, S3) is scoped.
	const actions = actionsOf(wildcards);
	assert.deepEqual([...new Set(actions)], ["ecr:GetAuthorizationToken"], `unexpected wildcard statements: ${JSON.stringify(wildcards)}`);
});

test("log and workload-token grants are scoped to this account and region", () => {
	const template = synth();
	const { statements } = policiesForRole(template, /AgentCore Runtime role/i);
	const logStatements = statements.filter((s) =>
		(Array.isArray(s.Action) ? s.Action : [s.Action]).some((a) => String(a).startsWith("logs:")),
	);
	assert.ok(logStatements.length > 0);
	for (const s of logStatements) {
		const res = JSON.stringify(s.Resource);
		assert.ok(!res.includes('"*"'), `logs statement must not use a bare wildcard: ${res}`);
		assert.ok(res.includes("eu-central-1") || res.includes("123456789012"), `logs statement must be scoped: ${res}`);
	}
	const wl = statements.filter((s) =>
		(Array.isArray(s.Action) ? s.Action : [s.Action]).some((a) => String(a).startsWith("bedrock-agentcore:")),
	);
	assert.ok(wl.length > 0);
	for (const s of wl) {
		assert.ok(!JSON.stringify(s.Resource).includes('"*"'), "workload-token statement must be scoped");
	}
});

test("OperatorRole no longer trusts the ec2 service placeholder", () => {
	const template = synth();
	const { role } = policiesForRole(template, /local pi cloud-mode extension/i);
	const trust = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
	assert.ok(!trust.includes("ec2.amazonaws.com"), "placeholder trust policy must be gone");
	assert.ok(trust.includes("AWS"), "trust must name an AWS principal (account root or the operator ARN)");

	const withArn = synth({ operatorPrincipalArn: "arn:aws:iam::123456789012:role/Admin" });
	const scoped = JSON.stringify(
		policiesForRole(withArn, /local pi cloud-mode extension/i).role.Properties.AssumeRolePolicyDocument,
	);
	assert.ok(scoped.includes("role/Admin"), "explicit operator principal must be used when provided");
});

// ── Forensics, cost and session ownership ─────────────

test("transcript bucket is private, encrypted, versioned and write-only for the worker", () => {
	const template = synth();
	const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
	assert.equal(buckets.length, 1);
	const props = buckets[0].Properties;
	assert.ok(props.BucketEncryption, "encryption at rest required (transcripts may quote proprietary code)");
	assert.equal(props.VersioningConfiguration?.Status, "Enabled");
	assert.deepEqual(props.PublicAccessBlockConfiguration, {
		BlockPublicAcls: true,
		BlockPublicPolicy: true,
		IgnorePublicAcls: true,
		RestrictPublicBuckets: true,
	});
	assert.ok(props.LifecycleConfiguration?.Rules?.[0]?.ExpirationInDays, "retention must be bounded");

	const { statements } = policiesForRole(template, /AgentCore Runtime role/i);
	const s3 = statements.filter((s) =>
		(Array.isArray(s.Action) ? s.Action : [s.Action]).some((a) => String(a).startsWith("s3:")),
	);
	assert.deepEqual([...new Set(actionsOf(s3))], ["s3:PutObject"], "worker writes transcripts, never reads them");
	assert.ok(JSON.stringify(s3[0].Resource).includes("transcripts/"), "S3 grant is prefix-scoped");
});

test("agent role still has no access to transcripts or secrets after the additions", () => {
	const template = synth();
	const actions = actionsOf(policiesForRole(template, /agent identity/i).statements);
	assert.deepEqual([...new Set(actions)].sort(), ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]);
});

test("runtime is configured with the server-side cap and owner-token requirement", () => {
	const env = Object.values(synth().findResources("AWS::BedrockAgentCore::Runtime"))[0].Properties
		.EnvironmentVariables;
	assert.equal(env.CLOUD_MODE_REQUIRE_OWNER_TOKEN, "1");
	assert.match(env.CLOUD_MODE_MAX_ACTIVE_SESSIONS, /^\d+$/);
	assert.ok(env.CLOUD_MODE_TRANSCRIPT_BUCKET, "worker must know where to archive transcripts");
});

test("a budget is created only when asked for, with notifications", () => {
	assert.equal(Object.keys(synth().findResources("AWS::Budgets::Budget")).length, 0);
	const withBudget = synth({ monthlyBudgetUsd: 200, budgetEmail: "ops@example.com" });
	const budgets = Object.values(withBudget.findResources("AWS::Budgets::Budget"));
	assert.equal(budgets.length, 1);
	assert.equal(budgets[0].Properties.Budget.BudgetLimit.Amount, 200);
	assert.equal(budgets[0].Properties.NotificationsWithSubscribers.length, 2);
});

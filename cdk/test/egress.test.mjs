// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Infrastructure invariants for egress restriction.
 *
 * The control these assertions protect is a *default*. Prompt injection is
 * assumed to succeed, so an unrestricted session can exfiltrate the whole
 * worktree; the firewall is what bounds that. Because restricted egress costs
 * money, the pressure to "temporarily" default it off is real — so the default
 * itself is asserted here, and a regression fails the build rather than quietly
 * shipping an open runtime.
 *
 * Synthesis only — nothing here touches an AWS account.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";

import { CloudModeStack, normaliseEgressTargets } from "../cloud-mode-stack.ts";

const ENV = { env: { account: "123456789012", region: "eu-central-1" } };

function synth(props = {}) {
	const app = new App();
	const stack = new CloudModeStack(app, props.stackId ?? "EgressTestStack", { ...ENV, ...props });
	return Template.fromStack(stack);
}

/** The single AgentCore runtime resource, whatever its logical id. */
function runtime(template) {
	const runtimes = template.findResources("AWS::BedrockAgentCore::Runtime");
	const entries = Object.values(runtimes);
	assert.equal(entries.length, 1, "expected exactly one AgentCore runtime");
	return entries[0].Properties;
}

function outputValue(template, key) {
	const outputs = template.findOutputs(key);
	return Object.values(outputs)[0]?.Value;
}

test("the DEFAULT synth runs the runtime in VPC mode behind the firewall", () => {
	const template = synth();
	const props = runtime(template);
	assert.equal(
		props.NetworkConfiguration?.NetworkMode,
		"VPC",
		"restricted egress must be the default — an open runtime has to be opted into",
	);
	template.resourceCountIs("AWS::NetworkFirewall::Firewall", 1);
	template.resourceCountIs("AWS::NetworkFirewall::FirewallPolicy", 1);
	assert.equal(outputValue(template, "EgressRestricted"), "true");
});

test("the default allow-list is non-empty and covers what a delivery needs", () => {
	const template = synth();
	const groups = Object.values(template.findResources("AWS::NetworkFirewall::RuleGroup"));
	const allowList = groups
		.map((g) => g.Properties?.RuleGroup?.RulesSource?.RulesSourceList)
		.find((l) => l?.GeneratedRulesType === "ALLOWLIST");
	assert.ok(allowList, "an ALLOWLIST rule group must exist");
	const targets = allowList.Targets ?? [];
	assert.ok(targets.length > 0, "the allow-list must not be empty");
	// Without these, a delegation cannot clone, install or push — and a validation
	// gate that cannot run fails closed, i.e. no deliveries at all.
	for (const required of [".github.com", ".githubusercontent.com", "registry.npmjs.org"]) {
		assert.ok(targets.includes(required), `allow-list is missing ${required}`);
	}
	// Network Firewall REJECTS duplicate targets, and treats `.x` as covering `x`.
	// This assertion exists because the service only says so at deploy time — a
	// duplicate here failed a real `cdk deploy` rather than any unit test.
	assert.equal(new Set(targets).size, targets.length, `duplicate targets: ${targets.join(", ")}`);
	for (const target of targets) {
		if (target.startsWith(".")) {
			assert.ok(!targets.includes(target.slice(1)), `${target} makes ${target.slice(1)} a duplicate`);
		}
	}
	assert.deepEqual(
		allowList.TargetTypes?.slice().sort(),
		["HTTP_HOST", "TLS_SNI"],
		"both SNI and Host must be inspected, or plain-HTTP egress slips through",
	);
});

test("extra domains are added without replacing the defaults", () => {
	const template = synth({ stackId: "ExtraDomains", extraEgressDomains: [".mycorp.dev"] });
	const groups = Object.values(template.findResources("AWS::NetworkFirewall::RuleGroup"));
	const targets =
		groups
			.map((g) => g.Properties?.RuleGroup?.RulesSource?.RulesSourceList)
			.find((l) => l?.GeneratedRulesType === "ALLOWLIST")?.Targets ?? [];
	assert.ok(targets.includes(".mycorp.dev"), "extra domain missing");
	assert.ok(targets.includes(".github.com"), "extra domains must not replace the defaults");
});

test("everything not allow-listed is dropped, not passed", () => {
	const template = synth();
	const policy = Object.values(template.findResources("AWS::NetworkFirewall::FirewallPolicy"))[0].Properties
		?.FirewallPolicy;
	const defaults = JSON.stringify(policy?.StatefulDefaultActions ?? []);
	assert.match(defaults, /drop/i, "the stateful default action must drop unmatched traffic");
});

test("opting out explicitly is possible and is reported in the outputs", () => {
	const template = synth({ stackId: "OpenEgress", restrictEgress: false });
	assert.equal(runtime(template).NetworkConfiguration?.NetworkMode, "PUBLIC");
	template.resourceCountIs("AWS::NetworkFirewall::Firewall", 0);
	assert.equal(
		outputValue(template, "EgressRestricted"),
		"false",
		"an open deployment must say so in its outputs, so the posture is discoverable",
	);
});

test("normaliseEgressTargets drops what Network Firewall would reject", () => {
	// The exact input that failed a real deploy: both forms of the same domain.
	assert.deepEqual(normaliseEgressTargets(["github.com", ".github.com"]), [".github.com"]);
	// Case-insensitive de-duplication.
	assert.deepEqual(normaliseEgressTargets(["PyPI.org", "pypi.org"]), ["pypi.org"]);
	// Unrelated domains and an unmatched bare domain survive untouched.
	assert.deepEqual(normaliseEgressTargets(["registry.npmjs.org", ".mycorp.dev", "crates.io"]), [
		"registry.npmjs.org",
		".mycorp.dev",
		"crates.io",
	]);
	// Blank entries from a comma-separated env var are ignored.
	assert.deepEqual(normaliseEgressTargets(["  ", "", "pypi.org"]), ["pypi.org"]);
});

test("restricted egress still leaves every AWS call the controls depend on reachable", () => {
	const template = synth({ stackId: "EndpointCoverage" });
	const services = Object.values(template.findResources("AWS::EC2::VPCEndpoint")).map((e) =>
		JSON.stringify(e.Properties?.ServiceName ?? ""),
	);
	const needed = ["bedrock-runtime", "secretsmanager", "ecr.api", "ecr.dkr", "logs", "sts", "s3"];
	for (const service of needed) {
		assert.ok(
			services.some((s) => s.includes(service)),
			`VPC mode removes internet egress, so ${service} needs an endpoint (missing). ` +
				`Without sts the Bedrock-only agent role cannot be assumed and the credential split fails.`,
		);
	}
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cloud Mode infrastructure — Bedrock AgentCore Runtime.
 *
 * Creates:
 *   - ECR image asset for the worker container (arm64, AgentCore contract).
 *   - Runtime role assumed by AgentCore: pull image, invoke Bedrock models,
 *     read the GitHub App secrets.
 *   - GitHub App secrets in Secrets Manager (populated out-of-band).
 *   - The AgentCore Runtime + a DEFAULT endpoint (networkMode VPC behind a
 *     Network Firewall egress allow-list BY DEFAULT;
 *     `CLOUD_MODE_RESTRICT_EGRESS=0` opts out into the old PUBLIC mode).
 *   - An "operator" IAM role the LOCAL pi extension needs:
 *     bedrock-agentcore:InvokeAgentRuntime / StopRuntimeSession.
 *
 * There is no ECS cluster, task definition, VPC/NAT, or CloudWatch Live-Tail
 * loop any more: AgentCore's session-scoped streaming invoke replaces all of it.
 *
 * After `cdk deploy`, feed the stack outputs into `.pi/cloud-mode.json`.
 */

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { CfnRuntime } from "aws-cdk-lib/aws-bedrockagentcore";
import {
	CfnRoute,
	GatewayVpcEndpointAwsService,
	InterfaceVpcEndpointAwsService,
	IpAddresses,
	Peer,
	Port,
	SecurityGroup,
	SubnetType,
	Vpc,
} from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { Effect, PolicyStatement, Role, ServicePrincipal, AccountRootPrincipal, ArnPrincipal } from "aws-cdk-lib/aws-iam";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import {
	CfnFirewall,
	CfnFirewallPolicy,
	CfnLoggingConfiguration,
	CfnRuleGroup,
} from "aws-cdk-lib/aws-networkfirewall";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { join } from "node:path";

export interface CloudModeStackProps extends StackProps {
	/** Model id passed to the worker (pi Bedrock provider). */
	model?: string;
	/** pi provider name used by the worker. */
	provider?: string;
	/**
	 * Validation gate the integration loop runs on the resolved tree BEFORE it
	 * pushes to the default branch (e.g. "npm ci && npm run lint && npm test").
	 * When set, a tree that fails this command is never pushed — this is what
	 * makes conflict auto-resolution safe. Unset ⇒ no gate (always passes).
	 */
	validateCmd?: string;
	/**
	 * Egress restriction: run the
	 * AgentCore runtime in `networkMode: VPC` behind an AWS Network Firewall whose
	 * stateful policy only allows outbound HTTP/TLS to an allow-listed set of
	 * domains. AWS service traffic (Bedrock, Secrets Manager, ECR, CloudWatch
	 * Logs) bypasses the firewall via VPC endpoints, so the allow-list stays
	 * minimal. All other outbound traffic from the worker — including exfiltration
	 * attempts driven by prompt injection — is dropped and alerted.
	 *
	 * **Defaults to true.** Prompt injection is assumed to succeed, so open
	 * egress means an injected agent can POST the worktree anywhere; that is the
	 * largest residual risk of the design. It costs real money (NAT gateway
	 * + Network Firewall + VPC endpoints), which is why the opt-out
	 * (`CLOUD_MODE_RESTRICT_EGRESS=0`) is documented — but it must be a decision,
	 * not an accident.
	 */
	restrictEgress?: boolean;
	/**
	 * Extra egress domains to allow when `restrictEgress` is set (e.g. a
	 * private package registry the validation gate needs). Prefix with a dot
	 * to allow a domain and all its subdomains (Suricata domain-list syntax),
	 * e.g. ".mycorp.dev".
	 */
	extraEgressDomains?: string[];
	/**
	 * Create a SCOPED AGENT ROLE (default) that may do nothing but invoke the
	 * pinned Bedrock model, and let the runtime role assume it. The worker vends
	 * this role — not its own runtime role — to the model traffic through a
	 * loopback broker, so code execution inside a session (prompt injection,
	 * hostile build script) can no longer reach
	 * `secretsmanager:GetSecretValue` on the GitHub App private key.
	 *
	 * Credential split ("two wallets instead of one").
	 * Set to false only to reproduce the pre-split behaviour.
	 */
	scopedAgentRole?: boolean;
	/**
	 * Refuse to run stories when a boundary cannot be established (unscoped
	 * credentials, or untrusted code that would share the orchestrator's OS user).
	 * Default true — tenet 4, loud failure over silent fallback. Set to false only
	 * if the platform cannot drop privileges and you accept the residual risk.
	 */
	requireIsolation?: boolean;
	/**
	 * IAM principal ARN that the local extension assumes / uses to invoke the
	 * runtime. Replaces the placeholder trust policy on the OperatorRole — an
	 * `ec2.amazonaws.com` trust was meaningless and could not be assumed by a
	 * human. When omitted, the OperatorRole trusts
	 * the deploying account root, which is the narrowest sane default.
	 */
	operatorPrincipalArn?: string;
	/**
	 * Persist a transcript artifact per session to S3.
	 * Default true: without it, forensics after a bad merge depend on
	 * CloudWatch alone and the worker's in-memory history dies with the microVM.
	 */
	transcriptArchive?: boolean;
	/** Days to keep transcripts (they may quote proprietary code). */
	transcriptRetentionDays?: number;
	/** CloudWatch log retention for worker logs. */
	logRetentionDays?: RetentionDays;
	/**
	 * Monthly USD budget for the account with an alert at 80% and 100%.
	 * Cost guardrails cannot be enforced by this
	 * stack, but they can be made visible. 0 disables the budget.
	 */
	monthlyBudgetUsd?: number;
	/** Email address for budget notifications (required for a budget to be useful). */
	budgetEmail?: string;
	/** Server-side concurrent-session cap in the worker. */
	maxActiveSessions?: number;
	/**
	 * Suffix appended to every globally-named resource (secrets, runtime name,
	 * firewall names). Empty by default so an existing deployment keeps its
	 * names; set it (together with a distinct stack id) to deploy an isolated
	 * test stack alongside a live one.
	 */
	resourceSuffix?: string;
}

/**
 * Normalise a Network Firewall domain allow-list.
 *
 * Two rules, both learned from a failed deploy:
 *   1. Targets must be unique (case-insensitively) — duplicates are rejected
 *      outright by the service.
 *   2. `.example.com` already covers `example.com`, so listing both is a
 *      duplicate in the service's eyes. Keep the dot-prefixed form, which is the
 *      broader of the two, and drop the bare one.
 *
 * Exported so a CDK invariant test can assert the property directly rather than
 * only through a synthesised template.
 */
export function normaliseEgressTargets(targets: string[]): string[] {
	const cleaned = targets.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
	const dotted = new Set(cleaned.filter((t) => t.startsWith(".")).map((t) => t.slice(1)));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const target of cleaned) {
		if (!target.startsWith(".") && dotted.has(target)) continue; // covered by `.target`
		if (seen.has(target)) continue;
		seen.add(target);
		out.push(target);
	}
	return out;
}

export class CloudModeStack extends Stack {
	constructor(scope: Construct, id: string, props: CloudModeStackProps = {}) {
		super(scope, id, props);

		const provider = props.provider ?? "amazon-bedrock";
		const model = props.model ?? "global.anthropic.claude-opus-5";
		const validateCmd = props.validateCmd?.trim();
		// Non-empty only for parallel (test) stacks: keeps globally-named resources
		// from colliding with a live deployment.
		const suffix = (props.resourceSuffix ?? "").trim();
		const named = (base: string) => (suffix ? `${base}-${suffix}` : base);
		const runtimeName = suffix ? `cloud_mode_worker_${suffix.replace(/[^A-Za-z0-9_]/g, "_")}` : "cloud_mode_worker";
		const scopedAgentRole = props.scopedAgentRole ?? true;
		const requireIsolation = props.requireIsolation ?? true;
		const transcriptArchive = props.transcriptArchive ?? true;
		const logRetention = props.logRetentionDays ?? RetentionDays.THREE_MONTHS;
		const maxActiveSessions = props.maxActiveSessions ?? 8;

		// ── Secrets (GitHub App creds; values populated out-of-band) ─────────
		const ghAppId = new Secret(this, "GhAppId", { secretName: named("cloud-mode/gh-app-id") });
		const ghInstallationId = new Secret(this, "GhInstallationId", {
			secretName: named("cloud-mode/gh-installation-id"),
		});
		const ghPrivateKey = new Secret(this, "GhPrivateKey", { secretName: named("cloud-mode/gh-app-private-key") });

		// ── Container image (arm64, AgentCore contract) ──────────────────────
		const image = new DockerImageAsset(this, "WorkerImage", {
			directory: join(import.meta.dirname, "..", "worker"),
			platform: Platform.LINUX_ARM64,
		});

		// ── Runtime role (assumed by AgentCore) ──────────────────────────────
		const runtimeRole = new Role(this, "RuntimeRole", {
			assumedBy: new ServicePrincipal("bedrock-agentcore.amazonaws.com"),
			description: "AgentCore Runtime role: ECR pull, secret read, assume the scoped agent role",
		});

		// ── Agent role (the only identity the LLM traffic ever uses) ─────────
		// Bedrock invoke and NOTHING else: no secrets, no ECR, no logs, no STS. The
		// worker assumes it at boot and vends it over loopback (aws-identity.mjs),
		// so credential theft inside a session buys Bedrock tokens, not the GitHub
		// App private key.
		const bedrockInvoke = new PolicyStatement({
			effect: Effect.ALLOW,
			actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
			resources: [
				"arn:aws:bedrock:*::foundation-model/*",
				`arn:aws:bedrock:*:${this.account}:inference-profile/*`,
			],
		});
		let agentRole: Role | undefined;
		if (scopedAgentRole) {
			agentRole = new Role(this, "AgentRole", {
				assumedBy: runtimeRole,
				description: "Cloud Mode agent identity: invoke the Bedrock model, nothing else",
				maxSessionDuration: Duration.hours(4),
			});
			agentRole.addToPolicy(bedrockInvoke);
			runtimeRole.addToPolicy(
				new PolicyStatement({
					effect: Effect.ALLOW,
					actions: ["sts:AssumeRole"],
					resources: [agentRole.roleArn],
				}),
			);
		} else {
			// Pre-split behaviour: the runtime role talks to Bedrock itself.
			runtimeRole.addToPolicy(bedrockInvoke);
		}
		// Pull the worker image from ECR.
		image.repository.grantPull(runtimeRole);
		runtimeRole.addToPolicy(
			// ecr:GetAuthorizationToken takes no resource (the API rejects any ARN), and
			// isolation.test.mjs asserts it is the ONLY wildcard statement in the stack.
			// nosemgrep: cloud-mode-iam-wildcard-resource
			new PolicyStatement({
				effect: Effect.ALLOW,
				actions: ["ecr:GetAuthorizationToken"],
				resources: ["*"],
			}),
		);
		// Read the GitHub App secrets at runtime.
		for (const s of [ghAppId, ghInstallationId, ghPrivateKey]) {
			s.grantRead(runtimeRole);
		}
		// AgentCore workload identity + CloudWatch logging.
		//
		// IAM tightening: scoped to the log groups AgentCore writes for this
		// runtime and to this runtime's workload identity, instead of `*`. AgentCore
		// creates its own log groups (`/aws/bedrock-agentcore/runtimes/...`), so the
		// grant is a path prefix rather than one ARN — still a bounded namespace
		// within this account and region.
		const logArnPrefixes = [
			`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
			`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*:log-stream:*`,
			`arn:aws:logs:${this.region}:${this.account}:log-group:/cloud-mode/*`,
			`arn:aws:logs:${this.region}:${this.account}:log-group:/cloud-mode/*:log-stream:*`,
		];
		runtimeRole.addToPolicy(
			new PolicyStatement({
				effect: Effect.ALLOW,
				actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
				resources: logArnPrefixes,
			}),
		);
		// DescribeLogGroups cannot be resource-scoped by the log group it returns;
		// keep it separate and read-only so the wildcard is visible and minimal.
		runtimeRole.addToPolicy(
			new PolicyStatement({
				effect: Effect.ALLOW,
				actions: ["logs:DescribeLogGroups"],
				resources: [`arn:aws:logs:${this.region}:${this.account}:log-group::log-stream:`],
			}),
		);
		runtimeRole.addToPolicy(
			new PolicyStatement({
				effect: Effect.ALLOW,
				actions: [
					"bedrock-agentcore:GetWorkloadAccessToken",
					"bedrock-agentcore:GetWorkloadAccessTokenForJWT",
					"bedrock-agentcore:GetWorkloadAccessTokenForUserId",
				],
				resources: [
					`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
					`arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/${runtimeName}*`,
				],
			}),
		);

		// ── Transcript artifact bucket ─────────────────────────────
		// Private, encrypted, versioned, lifecycle-expired. The worker writes one
		// JSONL object per session with the orchestrator identity; the agent role has
		// no S3 permissions at all.
		let transcriptBucket: Bucket | undefined;
		if (transcriptArchive) {
			transcriptBucket = new Bucket(this, "TranscriptBucket", {
				encryption: BucketEncryption.S3_MANAGED,
				blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
				enforceSSL: true,
				versioned: true,
				removalPolicy: RemovalPolicy.RETAIN,
				lifecycleRules: [{ expiration: Duration.days(props.transcriptRetentionDays ?? 90) }],
			});
			// Write-only, prefix-scoped: the worker never reads or lists transcripts.
			runtimeRole.addToPolicy(
				new PolicyStatement({
					effect: Effect.ALLOW,
					actions: ["s3:PutObject"],
					resources: [`${transcriptBucket.bucketArn}/transcripts/*`],
				}),
			);
		}

		// ── Cost visibility ───────────────────────────────
		// The concurrency caps bound how many agents run; a budget makes the spend
		// they cause visible. Advisory by nature — AWS Budgets notifies, it
		// does not stop anything.
		if (props.monthlyBudgetUsd && props.monthlyBudgetUsd > 0) {
			new CfnBudget(this, "MonthlyBudget", {
				budget: {
					budgetName: named("cloud-mode-monthly"),
					budgetType: "COST",
					timeUnit: "MONTHLY",
					budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
				},
				...(props.budgetEmail
					? {
							notificationsWithSubscribers: [80, 100].map((pct) => ({
								notification: {
									notificationType: "ACTUAL",
									comparisonOperator: "GREATER_THAN",
									threshold: pct,
									thresholdType: "PERCENTAGE",
								},
								subscribers: [{ subscriptionType: "EMAIL", address: props.budgetEmail }],
							})),
						}
					: {}),
			});
		}

		// ── T-4 egress restriction (opt-in): VPC + Network Firewall ─────────
		// Workload subnets have NO route to the internet except through the
		// firewall endpoint; the firewall only passes HTTP/TLS whose Host/SNI
		// matches the allow-list and drops everything else (strict order,
		// drop_established default). AWS APIs the worker needs are reached via
		// VPC endpoints so they never traverse the firewall or the allow-list.
		let vpcNetworkConfig: CfnRuntime.VpcConfigProperty | undefined;
		// Default-on: `restrictEgress: false` must be an explicit decision.
		const restrictEgress = props.restrictEgress ?? true;
		if (restrictEgress) {
			const vpc = new Vpc(this, "EgressVpc", {
				ipAddresses: IpAddresses.cidr("10.42.0.0/16"),
				maxAzs: 2, // AgentCore VPC mode requires >= 2 subnets
				natGateways: 1,
				subnetConfiguration: [
					{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
					// Default route -> NAT (created by the Vpc construct).
					{ name: "firewall", subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 28 },
					// PRIVATE_ISOLATED: no default route; we add 0.0.0.0/0 -> firewall below.
					{ name: "workload", subnetType: SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
				],
			});

			// Suricata domain-list semantics: `.example.com` matches example.com AND its
			// subdomains, so listing both forms is redundant — and Network Firewall
			// *rejects* it ("Targets has duplicate values"). That rejection only surfaces
			// at deploy time, which is why it survived while this feature was opt-in and
			// appeared the moment it became the default. normaliseEgressTargets() keeps
			// the broader (dot-prefixed) form and drops the redundant bare domain.
			const allowedDomains = normaliseEgressTargets([
				// GitHub API + git-over-https (codeload/api/uploads are *.github.com).
				".github.com",
				// LFS / release assets / raw content.
				".githubusercontent.com",
				// npm registry — the worker installs nothing at runtime, but the
				// validation gate typically runs `npm ci` on the target repo.
				"registry.npmjs.org",
				// Starter list for the other ecosystems the worker image ships toolchains
				// for. A validation gate that cannot fetch its dependencies fails closed,
				// which would otherwise turn this control into "no deliveries".
				"pypi.org",
				"files.pythonhosted.org",
				"crates.io",
				"static.crates.io",
				"proxy.golang.org",
				"sum.golang.org",
				// Debian security updates for a long-lived session.
				"deb.debian.org",
				"security.debian.org",
				...(props.extraEgressDomains ?? []),
			]);

			const allowListRuleGroup = new CfnRuleGroup(this, "EgressAllowList", {
				ruleGroupName: named("cloud-mode-egress-allowlist"),
				type: "STATEFUL",
				capacity: 100,
				ruleGroup: {
					statefulRuleOptions: { ruleOrder: "STRICT_ORDER" },
					ruleVariables: {
						ipSets: { HOME_NET: { definition: [vpc.vpcCidrBlock] } },
					},
					rulesSource: {
						rulesSourceList: {
							generatedRulesType: "ALLOWLIST",
							targetTypes: ["TLS_SNI", "HTTP_HOST"],
							targets: allowedDomains,
						},
					},
				},
			});

			const firewallPolicy = new CfnFirewallPolicy(this, "EgressFirewallPolicy", {
				firewallPolicyName: named("cloud-mode-egress-policy"),
				firewallPolicy: {
					statelessDefaultActions: ["aws:forward_to_sfe"],
					statelessFragmentDefaultActions: ["aws:forward_to_sfe"],
					statefulEngineOptions: { ruleOrder: "STRICT_ORDER" },
					// Anything the allow-list didn't explicitly pass is dropped
					// (incl. non-HTTP/TLS protocols) and alerted on.
					statefulDefaultActions: ["aws:drop_established", "aws:alert_established"],
					statefulRuleGroupReferences: [
						{ resourceArn: allowListRuleGroup.attrRuleGroupArn, priority: 10 },
					],
				},
			});

			// Single firewall endpoint (AZ0). Both workload subnets route through
			// it; cross-AZ latency is irrelevant for this workload and keeps the
			// endpoint-id -> AZ mapping deterministic in CloudFormation.
			const firewallSubnet = vpc.selectSubnets({ subnetGroupName: "firewall" }).subnets[0];
			const firewall = new CfnFirewall(this, "EgressFirewall", {
				firewallName: named("cloud-mode-egress-firewall"),
				firewallPolicyArn: firewallPolicy.attrFirewallPolicyArn,
				vpcId: vpc.vpcId,
				subnetMappings: [{ subnetId: firewallSubnet.subnetId }],
			});
			// attrEndpointIds entries look like "<az>:vpce-..."; one mapping ⇒ one entry.
			const firewallEndpointId = Fn.select(1, Fn.split(":", Fn.select(0, firewall.attrEndpointIds)));

			// Blocked-egress attempts are the T-4 forensic signal — keep them.
			const alertLogs = new LogGroup(this, "EgressFirewallAlerts", {
				retention: RetentionDays.THREE_MONTHS,
			});
			new CfnLoggingConfiguration(this, "EgressFirewallLogging", {
				firewallArn: firewall.attrFirewallArn,
				loggingConfiguration: {
					logDestinationConfigs: [
						{
							logType: "ALERT",
							logDestinationType: "CloudWatchLogs",
							logDestination: { logGroup: alertLogs.logGroupName },
						},
					],
				},
			});

			const workloadSubnets = vpc.selectSubnets({ subnetGroupName: "workload" }).subnets;
			// Forward path: workload -> firewall endpoint -> (firewall subnet RT) -> NAT -> IGW.
			workloadSubnets.forEach((subnet, i) => {
				new CfnRoute(this, `WorkloadDefaultToFirewall${i}`, {
					routeTableId: subnet.routeTable.routeTableId,
					destinationCidrBlock: "0.0.0.0/0",
					vpcEndpointId: firewallEndpointId,
				}).addDependency(firewall);
			});
			// Return path: NAT (public subnet) -> firewall endpoint -> workload.
			// More-specific-than-local routes steer intra-VPC return traffic back
			// through the firewall so flows stay symmetric.
			vpc.publicSubnets.forEach((pub, i) => {
				workloadSubnets.forEach((wl, j) => {
					new CfnRoute(this, `PublicReturnToFirewall${i}x${j}`, {
						routeTableId: pub.routeTable.routeTableId,
						destinationCidrBlock: wl.ipv4CidrBlock,
						vpcEndpointId: firewallEndpointId,
					}).addDependency(firewall);
				});
			});

			// AWS service access via VPC endpoints (bypasses firewall/allow-list).
			const endpointSg = new SecurityGroup(this, "VpcEndpointSg", {
				vpc,
				description: "Cloud Mode worker VPC endpoints (443 from VPC)",
				allowAllOutbound: false,
			});
			endpointSg.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(443));
			const interfaceServices: [string, InterfaceVpcEndpointAwsService][] = [
				["Bedrock", InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
				["SecretsManager", InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
				["EcrApi", InterfaceVpcEndpointAwsService.ECR],
				["EcrDkr", InterfaceVpcEndpointAwsService.ECR_DOCKER],
				["Logs", InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
				// STS is NOT optional: the worker assumes the Bedrock-only agent role
				// through sts:AssumeRole on every session. Without this endpoint
				// the call leaves the VPC, the firewall drops it, and the credential
				// split — the control that keeps the App private key out of the agent's
				// reach — cannot be established at all. Found by deploying: the runtime
				// logged "isolation setup failed: read ECONNABORTED" until this was added.
				["Sts", InterfaceVpcEndpointAwsService.STS],
			];
			for (const [name, service] of interfaceServices) {
				vpc.addInterfaceEndpoint(`${name}Endpoint`, {
					service,
					subnets: { subnetGroupName: "workload" },
					securityGroups: [endpointSg],
				});
			}
			vpc.addGatewayEndpoint("S3Endpoint", {
				service: GatewayVpcEndpointAwsService.S3,
				subnets: [{ subnetGroupName: "workload" }],
			});

			// SG on the runtime ENIs: open egress — the firewall (not the SG) is
			// the enforcement point for the domain allow-list.
			const runtimeSg = new SecurityGroup(this, "RuntimeSg", {
				vpc,
				description: "Cloud Mode AgentCore runtime ENIs",
				allowAllOutbound: true,
			});

			vpcNetworkConfig = {
				securityGroups: [runtimeSg.securityGroupId],
				subnets: workloadSubnets.map((s) => s.subnetId),
			};
		}

		// ── AgentCore Runtime + endpoint ─────────────────────────────────────
		const runtime = new CfnRuntime(this, "Runtime", {
			agentRuntimeName: runtimeName,
			description: "Cloud Mode pi worker (clone → solve story → PR, with live interaction)",
			agentRuntimeArtifact: {
				containerConfiguration: { containerUri: image.imageUri },
			},
			networkConfiguration: vpcNetworkConfig
				? { networkMode: "VPC", networkModeConfig: vpcNetworkConfig }
				: { networkMode: "PUBLIC" },
			protocolConfiguration: "HTTP",
			roleArn: runtimeRole.roleArn,
			environmentVariables: {
				AWS_REGION: this.region,
				PI_PROVIDER: provider,
				PI_MODEL: model,
				GH_APP_ID_SECRET: ghAppId.secretName,
				GH_INSTALLATION_ID_SECRET: ghInstallationId.secretName,
				GH_PRIVATE_KEY_SECRET: ghPrivateKey.secretName,
				// Scoped identity for the model traffic.
				// When set, the worker assumes this role and vends it — instead of its
				// own runtime role — over a loopback broker, and refuses to fall back
				// silently. Absent ⇒ the worker logs a DEGRADED credential scope.
				...(agentRole ? { CLOUD_MODE_AGENT_ROLE_ARN: agentRole.roleArn } : {}),
				// Fail closed: no unscoped credentials, no shared-uid execution of
				// untrusted code. Both boundaries exist in the image; a runtime that
				// cannot establish them should not run stories at all.
				...(scopedAgentRole ? { CLOUD_MODE_REQUIRE_SCOPED_CREDS: "1" } : {}),
				...(requireIsolation ? { CLOUD_MODE_REQUIRE_UID_SANDBOX: "1" } : {}),
				// Server-side concurrency cap and session-owner binding.
				CLOUD_MODE_MAX_ACTIVE_SESSIONS: String(maxActiveSessions),
				CLOUD_MODE_REQUIRE_OWNER_TOKEN: "1",
				// Durable transcript artifact per session.
				...(transcriptBucket ? { CLOUD_MODE_TRANSCRIPT_BUCKET: transcriptBucket.bucketName } : {}),
				// Only set when provided — an empty value would disable the gate anyway,
				// but omitting it keeps the runtime env clean.
				...(validateCmd ? { CLOUD_MODE_VALIDATE_CMD: validateCmd } : {}),
			},
		});

		// AgentCore automatically provisions a "DEFAULT" endpoint for every runtime,
		// so we must NOT create one ourselves (doing so fails with 409
		// AlreadyExists). The extension talks to the built-in DEFAULT qualifier.
		//
		// AgentCore validates ECR pull access when the runtime is created, so the
		// runtime role's (inline) policy granting ecr:BatchGetImage /
		// GetDownloadUrlForLayer / GetAuthorizationToken must exist first. Without
		// this dependency CloudFormation creates the role and the runtime in
		// parallel and the runtime fails with "Access denied while validating ECR
		// URI". Depending on the Role node also orders its DefaultPolicy child.
		runtime.node.addDependency(runtimeRole);

		// ── Operator role (used by the LOCAL pi extension) ──────────────────
		// A real principal, not the `ec2.amazonaws.com` placeholder. Remember
		// that holding this role's invoke permission IS GitHub write access to every
		// repo the App is installed on — grant it to humans deliberately.
		const operatorRole = new Role(this, "OperatorRole", {
			assumedBy: props.operatorPrincipalArn
				? new ArnPrincipal(props.operatorPrincipalArn)
				: new AccountRootPrincipal(),
			description: "Permissions the local pi cloud-mode extension needs",
		});
		operatorRole.addToPolicy(
			new PolicyStatement({
				effect: Effect.ALLOW,
				actions: [
					"bedrock-agentcore:InvokeAgentRuntime",
					"bedrock-agentcore:StopRuntimeSession",
				],
				resources: [runtime.attrAgentRuntimeArn, `${runtime.attrAgentRuntimeArn}/*`],
			}),
		);

		// ── Outputs → paste into .pi/cloud-mode.json ───────────────────────────
		new CfnOutput(this, "Region", { value: this.region });
		new CfnOutput(this, "AgentRuntimeArn", { value: runtime.attrAgentRuntimeArn });
		new CfnOutput(this, "AgentRuntimeId", { value: runtime.attrAgentRuntimeId });
		new CfnOutput(this, "RuntimeEndpointName", { value: "DEFAULT" });
		new CfnOutput(this, "RuntimeRoleArn", { value: runtimeRole.roleArn });
		new CfnOutput(this, "AgentRoleArn", {
			value: agentRole?.roleArn ?? "(none: runtime role used for model traffic)",
		});
		new CfnOutput(this, "EgressRestricted", { value: restrictEgress ? "true" : "false" });
		new CfnOutput(this, "OperatorRoleArn", { value: operatorRole.roleArn });
		new CfnOutput(this, "TranscriptBucketName", { value: transcriptBucket?.bucketName ?? "(disabled)" });
		new CfnOutput(this, "WorkerLogRetentionDays", { value: String(logRetention) });
	}
}

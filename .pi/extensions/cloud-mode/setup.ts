// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `/cloud-mode-setup` — interactive onboarding wizard + doctor.
 *
 * The wizard doesn't just report failing checks, it OFFERS TO FIX them
 * in-place:
 *   - config incomplete  → prompts region/owner, auto-fills the runtime ARN
 *                          from the deployed CloudFormation stack, writes
 *                          `.pi/cloud-mode.json`
 *   - GitHub App missing → runs the manifest flow (two browser clicks) and
 *                          stores all secrets in AWS Secrets Manager
 *   - no repo selected   → opens the repo picker
 *
 * The only step that stays outside pi is the one-time infra provisioning
 * (`cd cdk && npx cdk deploy`, wrapped by ./scripts/setup.sh) — a long-running
 * Docker/CDK build that belongs in a real terminal.
 *
 * In non-TUI modes the command degrades to a read-only doctor report.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type CloudModeConfig, loadConfig, saveConfig, saveSelectedRepo } from "./config.ts";
import { checkGitHubAppSecrets, createGitHubApp } from "./github-app.ts";
import { pickRepo } from "./repo-selector.ts";

const exec = promisify(execFile);

const RESTRICTIONS = [
	"Restrictions (current version):",
	"  • GitHub only — target repos must live on github.com (PRs via a GitHub App).",
	"  • AWS only — agents run on Amazon Bedrock AgentCore with Bedrock-hosted models.",
	"  • 🐳 The worker image must include the toolchain your project needs to compile & test",
	"     (language runtimes, compilers, package managers, libraries) — edit worker/Dockerfile",
	"     and redeploy (cd cdk && npx cdk deploy); missing toolchains make the validation gate skip.",
	"  • 💰 Each delegated story starts a billable AgentCore session — launched without a prompt;",
	"     the concurrency cap (maxConcurrentAgents) is the cost guard.",
	"  • 🔐 IAM ⇒ GitHub: any AWS principal allowed bedrock-agentcore:InvokeAgentRuntime on this runtime",
	"     can make agents push/PR to EVERY repo the GitHub App is installed on — the invoke payload picks",
	"     the target repo. Grant invoke narrowly and install the App per-repo (not 'All repositories').",
];

// ── Probes ────────────────────────────────────────────────────────────────────

interface CheckResult {
	ok: boolean;
	label: string;
	hint?: string;
}

async function checkAws(): Promise<CheckResult> {
	try {
		const { stdout } = await exec("aws", ["sts", "get-caller-identity", "--query", "Arn", "--output", "text"], {
			timeout: 15_000,
		});
		return { ok: true, label: `AWS credentials OK (${stdout.trim()})` };
	} catch (e) {
		const msg = (e as Error & { code?: string }).code === "ENOENT" ? "aws CLI not installed" : "credentials not working";
		return {
			ok: false,
			label: `AWS credentials — ${msg}`,
			hint: "Install the AWS CLI and run 'aws configure' (or set AWS_PROFILE). Cloud Mode runs ONLY on AWS (Bedrock AgentCore).",
		};
	}
}

async function checkGh(): Promise<CheckResult> {
	try {
		await exec("gh", ["auth", "status"], { timeout: 15_000 });
		return { ok: true, label: "GitHub CLI authenticated" };
	} catch (e) {
		const msg = (e as Error & { code?: string }).code === "ENOENT" ? "gh CLI not installed" : "not authenticated";
		return {
			ok: false,
			label: `GitHub CLI — ${msg}`,
			hint: "Install gh (https://cli.github.com) and run 'gh auth login'. Cloud Mode works ONLY with GitHub repos.",
		};
	}
}

async function ghLogin(): Promise<string | undefined> {
	try {
		const { stdout } = await exec("gh", ["api", "user", "--jq", ".login"], { timeout: 15_000 });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function defaultAwsRegion(): Promise<string | undefined> {
	try {
		const { stdout } = await exec("aws", ["configure", "get", "region"], { timeout: 15_000 });
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Look up the deployed CloudModeStack's AgentRuntimeArn output, if any. */
async function findRuntimeArn(region: string): Promise<string | undefined> {
	try {
		const { stdout } = await exec(
			"aws",
			[
				"cloudformation",
				"describe-stacks",
				"--stack-name",
				"CloudModeStack",
				"--region",
				region,
				"--query",
				"Stacks[0].Outputs[?OutputKey=='AgentRuntimeArn'].OutputValue",
				"--output",
				"text",
			],
			{ timeout: 30_000 },
		);
		const arn = stdout.trim();
		return arn && arn !== "None" ? arn : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read the CLOUD_MODE_VALIDATE_CMD env var configured on the deployed runtime.
 * Returns the command string, "" when unset, or undefined when it can't be read.
 */
async function readRuntimeValidateCmd(region: string, runtimeArn: string): Promise<string | undefined> {
	const runtimeId = runtimeArn.split("/").pop();
	if (!runtimeId) return undefined;
	try {
		const { stdout } = await exec(
			"aws",
			[
				"bedrock-agentcore-control",
				"get-agent-runtime",
				"--region",
				region,
				"--agent-runtime-id",
				runtimeId,
				"--query",
				"environmentVariables.CLOUD_MODE_VALIDATE_CMD",
				"--output",
				"text",
			],
			{ timeout: 30_000 },
		);
		const v = stdout.trim();
		return v === "None" ? "" : v;
	} catch {
		return undefined;
	}
}

// ── Doctor (read-only report; used standalone in non-TUI modes) ──────────────

export interface DoctorInput {
	trusted: boolean;
	config?: CloudModeConfig;
	configError?: string;
	configPath: string;
}

export async function runDoctor(input: DoctorInput): Promise<{ report: string; allOk: boolean }> {
	const checks: CheckResult[] = [];

	checks.push(
		input.trusted
			? { ok: true, label: "Project trusted" }
			: {
					ok: false,
					label: "Project not trusted",
					hint: "Trust this project in pi so the extension may read .pi/cloud-mode.json and launch agents.",
				},
	);

	if (input.configError || !input.config) {
		checks.push({
			ok: false,
			label: `Config incomplete (${input.configPath})`,
			hint: `${input.configError ?? "config not loaded"} — run /cloud-mode-setup in TUI mode for a guided fix.`,
		});
	} else {
		checks.push({
			ok: true,
			label: `Config OK (runtime ${input.config.agentRuntimeArn.split("/").pop()}, owner ${input.config.githubOwner}, max ${input.config.maxConcurrentAgents} agents, delivery ${input.config.deliveryMode})`,
		});
	}

	const [aws, gh] = await Promise.all([checkAws(), checkGh()]);
	checks.push(aws, gh);

	if (input.config && !input.configError && aws.ok) {
		const secretsOk = await checkGitHubAppSecrets(input.config.region);
		checks.push(
			secretsOk
				? { ok: true, label: "GitHub App secrets populated (Secrets Manager)" }
				: {
						ok: false,
						label: "GitHub App secrets not populated",
						hint: "Run /cloud-mode-setup in TUI mode to create the GitHub App, or use scripts/put-secrets.sh.",
					},
		);
	}

	checks.push(
		input.config?.repo
			? { ok: true, label: `Target repo selected: ${input.config.repo.nameWithOwner}` }
			: { ok: false, label: "No target repo selected", hint: "Run /cloud-mode-repo to pick or create one." },
	);

	// Validation gate: the command the integration loop runs on the resolved tree
	// before pushing. When no explicit command is set on the runtime, the worker
	// auto-detects the project ecosystem and validates it (see worker/validate.mjs),
	// so an unset gate is a project-aware default rather than "off".
	if (input.config && !input.configError && aws.ok) {
		const gate = await readRuntimeValidateCmd(input.config.region, input.config.agentRuntimeArn);
		if (gate === undefined) {
			checks.push({
				ok: true,
				label: "Validation gate: could not read runtime env (skipped)",
			});
		} else if (gate) {
			checks.push({ ok: true, label: `Validation gate (explicit override): ${gate}` });
		} else {
			checks.push({
				ok: true,
				label:
					"Validation gate: auto-detected per project (pnpm/npm/yarn/bun, and best-effort " +
					"python/rust/go/jvm/ruby; unknown stacks pass). " +
					"Detection only passes if the toolchain is in the worker image — add yours to " +
					"worker/Dockerfile and redeploy so build/test actually run. " +
					'Override anytime: CLOUD_MODE_VALIDATE_CMD="…" ./scripts/setup.sh',
			});
		}
	}

	const allOk = checks.every((c) => c.ok);
	const lines: string[] = ["Cloud Mode setup check", ""];
	for (const c of checks) {
		lines.push(`${c.ok ? "✅" : "❌"} ${c.label}`);
		if (!c.ok && c.hint) lines.push(`   ↳ ${c.hint}`);
	}
	lines.push("", ...RESTRICTIONS, "");
	// Escape hatches currently in force (T-027 / M-037). A project can be perfectly
	// "green" and still deliver ungated code, so the report names the hatches
	// explicitly rather than leaving them to be discovered in a commit trailer.
	const hatches: string[] = [];
	if (input.config && input.config.requireBranchProtection === false) {
		hatches.push('"requireBranchProtection": false in .pi/cloud-mode.json — the branch-protection precondition is OFF');
	}
	if (/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_REQUIRE_BRANCH_PROTECTION === "0" ? "1" : "")) {
		hatches.push("CLOUD_MODE_REQUIRE_BRANCH_PROTECTION=0 — the branch-protection precondition is OFF");
	}
	if (/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_ALLOW_UNVALIDATED ?? "")) {
		hatches.push("CLOUD_MODE_ALLOW_UNVALIDATED=1 — a validation gate that cannot run counts as a pass");
	}
	if (hatches.length) {
		lines.push("⚠️  Ungated-delivery escape hatches active:");
		for (const h of hatches) lines.push(`   • ${h}`);
		lines.push("   Deliveries made this way are stamped `Cloud-Mode-Ungated:` in the commit and flagged in the PR body.", "");
	}
	lines.push(
		allOk
			? 'All checks passed — ask pi to delegate a story, e.g. "Delegate STORY-1: add a healthcheck endpoint."'
			: "Fix the ❌ items above, then re-run /cloud-mode-setup.",
	);
	return { report: lines.join("\n"), allOk };
}

// ── Wizard (interactive; TUI only) ────────────────────────────────────────────

export interface WizardDeps {
	configDirName: string;
	/** Emit the final report into the transcript. */
	emitReport: (report: string) => void;
}

/**
 * Run the interactive setup wizard. Returns true when everything ended up
 * green. Each step checks first and only prompts when a fix is needed, so
 * re-running is idempotent and fast.
 */
export async function runWizard(ctx: ExtensionCommandContext, deps: WizardDeps): Promise<boolean> {
	const configPath = `${deps.configDirName}/cloud-mode.json`;
	const reload = () => loadConfig(ctx.cwd, deps.configDirName, ctx.isProjectTrusted());

	// Step 0: restrictions — make sure new users know what they're signing up for.
	const proceed = await ctx.ui.confirm(
		"Cloud Mode setup — GitHub + AWS only",
		"Cloud Mode needs repos on github.com (PRs via a GitHub App) and an AWS account with Bedrock " +
			"model access (agents run on billable AgentCore sessions). The worker image must also carry the " +
			"toolchain your project needs to compile & test (edit worker/Dockerfile, then redeploy). Other Git " +
			"hosts, clouds, and LLM providers are not supported. Continue?",
	);
	if (!proceed) return false;

	// Step 1: trust — nothing works without it, and we can't grant it ourselves.
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("Project is not trusted. Restart pi, trust this project when asked, then re-run /cloud-mode-setup.", "error");
		return false;
	}

	// Step 2: AWS credentials — hard requirement for every later step.
	const aws = await checkAws();
	if (!aws.ok) {
		ctx.ui.notify(`${aws.label}. ${aws.hint}`, "error");
		return false;
	}

	// Step 3: gh CLI — needed for the repo picker and owner default; warn but continue.
	const gh = await checkGh();
	if (!gh.ok) ctx.ui.notify(`${gh.label}. ${gh.hint}`, "warning");

	// Step 4: config file — prompt for the two real decisions, auto-fill the rest.
	let { config, error: configError } = reload();
	if (configError || !config) {
		const fix = await ctx.ui.confirm("Cloud Mode is not configured", `Create ${configPath} now?`);
		if (!fix) return false;

		const regionDefault = config?.region || (await defaultAwsRegion()) || "eu-central-1";
		const region = ((await ctx.ui.input("AWS region of the CloudModeStack", regionDefault)) || regionDefault).trim();

		ctx.ui.notify(`Looking up the deployed CloudModeStack in ${region}…`, "info");
		const runtimeArn = await findRuntimeArn(region);
		if (!runtimeArn) {
			ctx.ui.notify(
				`No CloudModeStack found in ${region}. Deploy the infrastructure first (one-time): ./scripts/setup.sh — or: cd cdk && npx cdk deploy. Then re-run /cloud-mode-setup.`,
				"error",
			);
			return false;
		}

		const ownerDefault = config?.githubOwner || (await ghLogin()) || "";
		const owner = ((await ctx.ui.input("GitHub owner/org whose repos agents work on", ownerDefault)) || ownerDefault).trim();
		if (!owner) {
			ctx.ui.notify("GitHub owner is required.", "error");
			return false;
		}

		saveConfig(ctx.cwd, deps.configDirName, {
			region,
			agentRuntimeArn: runtimeArn,
			qualifier: config?.qualifier ?? "DEFAULT",
			githubOwner: owner,
			maxConcurrentAgents: config?.maxConcurrentAgents ?? 5,
			deliveryMode: config?.deliveryMode ?? "pull-request",
		});
		ctx.ui.notify(`Wrote ${configPath}.`, "info");
		({ config, error: configError } = reload());
		if (configError || !config) {
			ctx.ui.notify(configError ?? "Config still incomplete after writing — please check the file.", "error");
			return false;
		}
	}

	// Step 5: GitHub App secrets — offer the two-click manifest flow.
	if (!(await checkGitHubAppSecrets(config.region))) {
		const create = await ctx.ui.confirm(
			"GitHub App not set up",
			"The cloud worker pushes and opens PRs via a GitHub App. Create it now? This opens your browser " +
				"twice (create + install); keys and secrets are handled automatically.",
		);
		if (create) {
			try {
				const res = await createGitHubApp({
					owner: config.githubOwner,
					region: config.region,
					cwd: ctx.cwd,
					onProgress: (m) => ctx.ui.notify(m, "info"),
				});
				if (res.installationId === undefined) {
					ctx.ui.notify(
						`App '${res.slug}' created but no installation detected. Install it at https://github.com/apps/${res.slug}/installations/new and re-run /cloud-mode-setup.`,
						"warning",
					);
				}
			} catch (e) {
				ctx.ui.notify(`GitHub App setup failed: ${(e as Error).message}`, "error");
			}
		} else {
			ctx.ui.notify("Skipped. Bring your own App later via scripts/put-secrets.sh, or re-run /cloud-mode-setup.", "warning");
		}
	}

	// Step 6: target repo — reuse the picker.
	if (!config.repo && gh.ok) {
		const pick = await ctx.ui.confirm("No target repo selected", "Pick the GitHub repo the agents will work on now?");
		if (pick) {
			const repo = await pickRepo(ctx, config.githubOwner);
			if (repo) {
				saveSelectedRepo(ctx.cwd, deps.configDirName, repo);
				ctx.ui.notify(`Target repo: ${repo.nameWithOwner} (base: ${repo.defaultBranch})`, "info");
			}
		}
	}

	// Final: re-run all checks and emit the report into the transcript.
	({ config, error: configError } = reload());
	const { report, allOk } = await runDoctor({
		trusted: ctx.isProjectTrusted(),
		config,
		configError,
		configPath,
	});
	deps.emitReport(report);
	return allOk;
}

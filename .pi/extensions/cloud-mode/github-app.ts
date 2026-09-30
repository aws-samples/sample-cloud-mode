// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub App creation via the App Manifest flow — extension-native port of
 * `scripts/create-github-app.mjs`, driven by the setup wizard.
 *
 * GitHub Apps cannot be created fully headless: the manifest flow needs ONE
 * browser click to confirm creation and ONE to install. Everything else is
 * automated here:
 *   1. start a local callback server
 *   2. open the browser with a pre-filled, auto-submitted manifest form
 *   3. on redirect, exchange the temp code → { app id, slug, pem }
 *   4. save the pem locally, open the install page
 *   5. poll the API (JWT auth) for the installation id
 *   6. write the cloud-mode/* secrets to AWS Secrets Manager (aws CLI)
 */

import { execFile, spawn } from "node:child_process";
import { createPrivateKey, createSign, randomBytes } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface CreateGitHubAppOptions {
	/** GitHub user/org the app is created for (used in the default name). */
	owner: string;
	/** AWS region the cloud-mode/* secrets live in. */
	region: string;
	/** Directory to save the private key pem into (gitignored via *.pem). */
	cwd: string;
	/** Progress callback (wizard surfaces these as notifications). */
	onProgress: (message: string) => void;
	appName?: string;
	port?: number;
}

export interface CreateGitHubAppResult {
	appId: number;
	slug: string;
	/** Local .pem path, or undefined when it was deleted after the secret was verified (M-015). */
	pemPath?: string;
	/** Undefined when the user never completed the install click. */
	installationId?: number;
}

function openBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function html(body: string): string {
	return `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body>`;
}

function ghFetch(path: string, opts: RequestInit = {}): Promise<Response> {
	return fetch(`https://api.github.com${path}`, {
		...opts,
		headers: { Accept: "application/vnd.github+json", "User-Agent": "cloud-mode-setup", ...(opts.headers || {}) },
	});
}

function appJwt(appId: number, pem: string): string {
	const now = Math.floor(Date.now() / 1000);
	const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
	const sig = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(pem), "base64url");
	return `${unsigned}.${sig}`;
}

async function putSecret(region: string, id: string, value: string): Promise<void> {
	await exec("aws", ["secretsmanager", "put-secret-value", "--region", region, "--secret-id", id, "--secret-string", value], {
		timeout: 30_000,
	});
}

/** Read a secret back, so the wizard can verify a write before deleting the local copy. */
async function readSecret(region: string, id: string): Promise<string | undefined> {
	const { stdout } = await exec(
		"aws",
		[
			"secretsmanager",
			"get-secret-value",
			"--region",
			region,
			"--secret-id",
			id,
			"--query",
			"SecretString",
			"--output",
			"text",
		],
		{ timeout: 30_000 },
	);
	return stdout?.toString();
}

async function pollInstallationId(appId: number, pem: string, signal?: AbortSignal): Promise<number | undefined> {
	for (let i = 0; i < 60; i++) {
		if (signal?.aborted) return undefined;
		const res = await ghFetch("/app/installations", { headers: { Authorization: `Bearer ${appJwt(appId, pem)}` } });
		if (res.ok) {
			const list = (await res.json()) as Array<{ id: number }>;
			if (Array.isArray(list) && list.length > 0) return list[0].id;
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	return undefined;
}

interface ConvertedApp {
	id: number;
	slug: string;
	pem: string;
}

/**
 * Run the full manifest flow. Resolves once the app is created and (if the
 * user completes the install click within ~3 minutes) installed, with all
 * three cloud-mode/* secrets written to Secrets Manager.
 */
export async function createGitHubApp(opts: CreateGitHubAppOptions): Promise<CreateGitHubAppResult> {
	const port = opts.port ?? 8723;
	const redirect = `http://localhost:${port}/callback`;
	// CSRF guard: GitHub echoes `state` back on the manifest redirect. Only a
	// callback carrying this exact value can have originated from the form we
	// served — a drive-by navigation to /callback with an attacker-minted code
	// (which would make us adopt an attacker-owned App) is rejected.
	const state = randomBytes(32).toString("base64url");
	const appName = opts.appName ?? `cloud-mode-agent-${opts.owner}-${Math.random().toString(36).slice(2, 7)}`;

	const manifest = {
		name: appName,
		url: "https://github.com/earendil-works/pi-cloud-mode-extension",
		redirect_url: redirect,
		public: false,
		default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
		default_events: [],
	};

	opts.onProgress(`Creating GitHub App "${appName}" — your browser will open; click "Create GitHub App".`);

	const created = await new Promise<ConvertedApp>((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${port}`);

			if (url.pathname === "/") {
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					html(
						`<h2>Creating GitHub App…</h2><p>Redirecting you to GitHub. Review and click <b>Create GitHub App</b>.</p>
             <form id=f action="https://github.com/settings/apps/new?state=${state}" method=post>
               <input type=hidden name=manifest value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
             </form><script>document.getElementById('f').submit()</script>`,
					),
				);
				return;
			}

			if (url.pathname === "/callback") {
				if (url.searchParams.get("state") !== state) {
					res.writeHead(403, { "content-type": "text/html" });
					res.end(html("<h2>Invalid state.</h2><p>This callback did not originate from the running setup wizard — ignored.</p>"));
					return;
				}
				const code = url.searchParams.get("code");
				if (!code) {
					res.writeHead(400, { "content-type": "text/html" });
					res.end(html("<h2>Missing code.</h2>"));
					return;
				}
				try {
					const conv = await ghFetch(`/app-manifests/${code}/conversions`, { method: "POST" });
					if (!conv.ok) throw new Error(`conversion failed: ${conv.status} ${await conv.text()}`);
					const app = (await conv.json()) as ConvertedApp;
					// M-016: send the operator to the install page with an explicit warning to
					// pick individual repositories. The installation scope IS the repository
					// allow-list of the whole system (threat model T-020): with "All
					// repositories", every other threat in the model becomes org-wide.
					const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
					res.writeHead(200, { "content-type": "text/html" });
					res.end(
						html(
							`<h2>✅ App created: ${app.slug} (id ${app.id})</h2>
               <p><b>Next:</b> install the app, then return to pi.</p>
               <p style="padding:10px;border-left:3px solid #d29922;background:#231d10;text-align:left">
                 <b>Required: choose “Only select repositories”</b> and pick just the repos Cloud
                 Mode may write to. That selection is the security boundary of the whole system:
                 anyone who can invoke the runtime can make an agent push to every repository
                 this app is installed on. “All repositories” is not a supported configuration —
                 it makes every risk in this system org-wide.
               </p>
               <p><a href="${installUrl}">${installUrl}</a></p>
               <script>setTimeout(()=>location.href=${JSON.stringify(installUrl)},2500)</script>`,
						),
					);
					server.close();
					resolve(app);
				} catch (err) {
					res.writeHead(500, { "content-type": "text/html" });
					res.end(html(`<h2>Error</h2><pre>${String(err)}</pre>`));
					server.close();
					reject(err as Error);
				}
				return;
			}

			res.writeHead(404);
			res.end();
		});
		server.on("error", reject);
		server.listen(port, () => openBrowser(`http://localhost:${port}/`));
		// Safety valve: don't hang the wizard forever if the user closes the tab.
		setTimeout(
			() => {
				server.close();
				reject(new Error("Timed out waiting for GitHub App creation (10 min). Re-run /cloud-mode-setup to retry."));
			},
			10 * 60 * 1000,
		).unref();
	});

	// M-015 (PEM hygiene): the canonical copy of the private key belongs in
	// Secrets Manager. The local copy is written owner-only (0600) and deleted once
	// the secret write is verified — this key mints write tokens for every installed
	// repository, so it must not linger in a project directory where a stray
	// `git add -f`, an editor backup or a sync client can pick it up.
	// `CLOUD_MODE_KEEP_LOCAL_PEM=1` keeps it.
	const pemPath = join(opts.cwd, "cloud-mode-agent.private-key.pem");
	writeFileSync(pemPath, created.pem, { encoding: "utf-8", mode: 0o600 });
	try {
		chmodSync(pemPath, 0o600);
	} catch {
		/* best effort on exotic filesystems */
	}

	opts.onProgress(`App '${created.slug}' created (id ${created.id}). Storing secrets…`);
	await putSecret(opts.region, "cloud-mode/gh-app-id", String(created.id));
	await putSecret(opts.region, "cloud-mode/gh-app-private-key", created.pem);

	let pemRemoved = false;
	if (!/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_KEEP_LOCAL_PEM ?? "")) {
		// Never trade a stored key for no key: only delete after a successful readback.
		const stored = await readSecret(opts.region, "cloud-mode/gh-app-private-key").catch(() => undefined);
		if (stored?.includes("PRIVATE KEY")) {
			try {
				rmSync(pemPath, { force: true });
				pemRemoved = true;
				opts.onProgress(
					"Private key verified in Secrets Manager; local .pem deleted (set CLOUD_MODE_KEEP_LOCAL_PEM=1 to keep it).",
				);
			} catch {
				opts.onProgress(`Could not delete the local .pem — remove ${pemPath} manually.`);
			}
		} else {
			opts.onProgress(`Kept local .pem at ${pemPath} (could not verify the stored secret).`);
		}
	}

	opts.onProgress("Waiting for you to install the app in the browser (this detects it automatically)…");
	const installationId = await pollInstallationId(created.id, created.pem);
	if (installationId !== undefined) {
		await putSecret(opts.region, "cloud-mode/gh-installation-id", String(installationId));
		opts.onProgress(`Installation detected (id ${installationId}). All GitHub secrets stored.`);
	}

	return { appId: created.id, slug: created.slug, pemPath: pemRemoved ? undefined : pemPath, installationId };
}

/**
 * Heuristic check whether the GitHub App secrets are actually populated
 * (CDK creates them with generated random values). A real app id is numeric
 * and a real private key starts with a PEM header.
 */
export async function checkGitHubAppSecrets(region: string): Promise<boolean> {
	const get = async (id: string): Promise<string | undefined> => {
		try {
			const { stdout } = await exec(
				"aws",
				["secretsmanager", "get-secret-value", "--region", region, "--secret-id", id, "--query", "SecretString", "--output", "text"],
				{ timeout: 30_000 },
			);
			return stdout.trim();
		} catch {
			return undefined;
		}
	};
	const [appId, installId, pem] = await Promise.all([
		get("cloud-mode/gh-app-id"),
		get("cloud-mode/gh-installation-id"),
		get("cloud-mode/gh-app-private-key"),
	]);
	return /^\d+$/.test(appId ?? "") && /^\d+$/.test(installId ?? "") && (pem ?? "").startsWith("-----BEGIN");
}

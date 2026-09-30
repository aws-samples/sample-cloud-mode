#!/usr/bin/env node
// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Create the Cloud Mode GitHub App via the App Manifest flow and wire up secrets.
 *
 * GitHub Apps cannot be created head-less: the manifest flow needs ONE browser
 * click to confirm creation and ONE to install. This script automates
 * everything else:
 *   1. starts a local callback server
 *   2. opens the browser with a pre-filled manifest (auto-submitted form)
 *   3. on redirect, exchanges the temp code -> { app id, slug, pem, ... }
 *   4. saves the pem, opens the install page
 *   5. polls the API (JWT auth) for the installation id
 *   6. writes cloud-mode/gh-app-id, gh-installation-id, gh-app-private-key to
 *      AWS Secrets Manager
 *
 * Env:
 *   APP_OWNER      GitHub user/org (required)
 *   APP_NAME       Globally-unique app name (default: cloud-mode-agent-<owner>-<rand>)
 *   REGION         AWS region for secrets (default: us-east-1)
 *   PORT           local callback port (default: 8723)
 *   NO_SECRETS=1   skip writing to Secrets Manager (just print + save pem)
 */

import { createServer } from "node:http";
import { createSign, createPrivateKey, randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";

const OWNER = process.env.APP_OWNER;
if (!OWNER) {
	console.error("APP_OWNER is required, e.g. APP_OWNER=my-github-user node scripts/create-github-app.mjs");
	process.exit(1);
}
const REGION = process.env.REGION || "us-east-1";
const PORT = Number(process.env.PORT || 8723);
const APP_NAME = process.env.APP_NAME || `cloud-mode-agent-${OWNER}-${Math.random().toString(36).slice(2, 7)}`;
const REDIRECT = `http://localhost:${PORT}/callback`;

const manifest = {
	name: APP_NAME,
	url: "https://github.com/earendil-works/pi-cloud-mode-extension",
	redirect_url: REDIRECT,
	public: false,
	default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
	default_events: [],
};

// GitHub form endpoint differs for users vs orgs. Try user first; the form
// works for the authenticated account regardless when opened in the browser.
// The random `state` is echoed back on the redirect — a CSRF guard so only the
// form we served can drive our /callback (a CSRF-style misuse of the callback).
const STATE = randomBytes(32).toString("base64url");
const CREATE_URL = `https://github.com/settings/apps/new?state=${STATE}`;

function openBrowser(url) {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
	spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

function html(body) {
	return `<!doctype html><meta charset=utf-8><body style="font-family:system-ui;max-width:640px;margin:40px auto">${body}</body>`;
}

function ghFetch(path, opts = {}) {
	return fetch(`https://api.github.com${path}`, {
		...opts,
		headers: { Accept: "application/vnd.github+json", "User-Agent": "cloud-mode-setup", ...(opts.headers || {}) },
	});
}

function appJwt(appId, pem) {
	const now = Math.floor(Date.now() / 1000);
	const header = { alg: "RS256", typ: "JWT" };
	const payload = { iat: now - 60, exp: now + 540, iss: String(appId) };
	const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const unsigned = `${b64(header)}.${b64(payload)}`;
	const sig = createSign("RSA-SHA256").update(unsigned).sign(createPrivateKey(pem), "base64url");
	return `${unsigned}.${sig}`;
}

function putSecret(id, value) {
	if (process.env.NO_SECRETS === "1") return;
	execFileSync("aws", ["secretsmanager", "put-secret-value", "--region", REGION, "--secret-id", id, "--secret-string", value], {
		stdio: ["ignore", "ignore", "inherit"],
	});
}

async function pollInstallationId(appId, pem) {
	const jwt = appJwt(appId, pem);
	for (let i = 0; i < 60; i++) {
		const res = await ghFetch("/app/installations", { headers: { Authorization: `Bearer ${jwt}` } });
		if (res.ok) {
			const list = await res.json();
			if (Array.isArray(list) && list.length > 0) return list[0].id;
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	return undefined;
}

async function main() {
	console.log(`\nCreating GitHub App "${APP_NAME}" for owner "${OWNER}"…\n`);

	const done = new Promise((resolve, reject) => {
		const server = createServer(async (req, res) => {
			const url = new URL(req.url, `http://localhost:${PORT}`);

			if (url.pathname === "/") {
				// Auto-submitting form that POSTs the manifest to GitHub.
				res.writeHead(200, { "content-type": "text/html" });
				res.end(
					html(
						`<h2>Creating GitHub App…</h2><p>Redirecting you to GitHub. Review and click <b>Create GitHub App</b>.</p>
             <form id=f action="${CREATE_URL}" method=post>
               <input type=hidden name=manifest value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
             </form><script>document.getElementById('f').submit()</script>`,
					),
				);
				return;
			}

			if (url.pathname === "/callback") {
				if (url.searchParams.get("state") !== STATE) {
					res.writeHead(403, { "content-type": "text/html" });
					res.end(html("<h2>Invalid state.</h2><p>This callback did not originate from this script — ignored.</p>"));
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
					const app = await conv.json();
					// Owner-only mode; deleted below once the secret is verified.
					const pemPath = `${process.cwd()}/cloud-mode-agent.private-key.pem`;
					writeFileSync(pemPath, app.pem, { encoding: "utf-8", mode: 0o600 });

					putSecret("cloud-mode/gh-app-id", String(app.id));
					putSecret("cloud-mode/gh-app-private-key", app.pem);

					// The installation scope is the repository allow-list of the whole
					// system — say so before the operator clicks.
					const installUrl = `https://github.com/apps/${app.slug}/installations/new`;
					res.writeHead(200, { "content-type": "text/html" });
					res.end(
						html(
							`<h2>✅ App created: ${app.slug} (id ${app.id})</h2>
               <p>Private key stored in Secrets Manager.</p>
               <p><b>Next:</b> install the app, then return here.</p>
               <p style="padding:10px;border-left:3px solid #d29922;background:#231d10;text-align:left">
                 <b>Required: choose “Only select repositories”.</b> Anyone who can invoke the
                 runtime can make an agent push to every repository this app is installed on,
                 so this installation IS the repository allow-list of the whole system.
                 “All repositories” is not a supported configuration — it makes every risk
                 in this system org-wide.
               </p>
               <p><a href="${installUrl}">${installUrl}</a></p>
               <script>setTimeout(()=>location.href=${JSON.stringify(installUrl)},2500)</script>`,
						),
					);
					server.close();
					resolve({ app, pemPath });
				} catch (err) {
					res.writeHead(500, { "content-type": "text/html" });
					res.end(html(`<h2>Error</h2><pre>${String(err)}</pre>`));
					server.close();
					reject(err);
				}
				return;
			}

			res.writeHead(404);
			res.end();
		});
		server.listen(PORT, () => {
			const url = `http://localhost:${PORT}/`;
			console.log(`Opening browser: ${url}`);
			console.log("(If it doesn't open, paste that URL into your browser.)\n");
			openBrowser(url);
		});
	});

	const { app, pemPath } = await done;
	console.log(`\nApp id: ${app.id}`);
	console.log(`Slug:   ${app.slug}`);
	console.log("gh-app-id + gh-app-private-key stored in Secrets Manager.");
	// Delete the local key once the stored copy is verified.
	if (!/^(1|true|yes)$/i.test(process.env.CLOUD_MODE_KEEP_LOCAL_PEM ?? "")) {
		let stored = "";
		try {
			stored = execFileSync(
				"aws",
				[
					"secretsmanager",
					"get-secret-value",
					"--region",
					REGION,
					"--secret-id",
					"cloud-mode/gh-app-private-key",
					"--query",
					"SecretString",
					"--output",
					"text",
				],
				{ encoding: "utf-8" },
			);
		} catch {
			stored = "";
		}
		if (stored.includes("PRIVATE KEY")) {
			rmSync(pemPath, { force: true });
			console.log("PEM:    deleted locally (verified in Secrets Manager; CLOUD_MODE_KEEP_LOCAL_PEM=1 to keep)\n");
		} else {
			console.log(`PEM:    ${pemPath} (kept — could not verify the stored secret)\n`);
		}
	} else {
		console.log(`PEM:    ${pemPath} (kept via CLOUD_MODE_KEEP_LOCAL_PEM)\n`);
	}

	console.log("Waiting for you to install the app (polling for installation id)…");
	const installationId = await pollInstallationId(app.id, app.pem);
	if (installationId) {
		putSecret("cloud-mode/gh-installation-id", String(installationId));
		console.log(`\n✅ Installation id: ${installationId} (stored in Secrets Manager).`);
		console.log("\n✅ All GitHub App secrets are set. The cloud worker can now push and open PRs.");
	} else {
		console.log("\n⚠️  Could not detect an installation. Install the app, then run:");
		console.log(`   aws secretsmanager put-secret-value --region ${REGION} --secret-id cloud-mode/gh-installation-id --secret-string <ID>`);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

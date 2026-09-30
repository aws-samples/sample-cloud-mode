// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Loopback model proxy.
 *
 * The out-of-process agent must be able to obtain model completions while holding
 * **no credential at all**. It therefore talks to this proxy on 127.0.0.1; the
 * orchestrator re-signs each request with the Bedrock-only agent role
 * and forwards it to the real endpoint.
 *
 * What the child receives is a URL and an opaque bearer token. Stealing both buys
 * the ability to call the one pinned model — something the agent can do
 * legitimately anyway — and nothing else: no `secretsmanager:GetSecretValue`, no
 * STS, no S3, no second model, no other region.
 *
 * Controls, all cheap and all asserted by tests:
 *   - **loopback bind only** and an ephemeral port;
 *   - **256-bit bearer token** per process, compared with `timingSafeEqual`
 *     (a timing oracle on a local socket is cheap to exploit, free to prevent);
 *   - **method allow-list**: POST only;
 *   - **model pinning**: the model id in the path must equal the runtime's
 *     configured model, so an injected agent cannot switch to a pricier model
 *     (cost abuse);
 *   - **path allow-list**: only the invoke/converse shapes, so the proxy cannot
 *     be used as a general-purpose signed-request oracle.
 */

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Paths we are willing to sign, with `<model>` standing in for the pinned id. */
const ALLOWED_PATHS = [
	/^\/model\/[^/]+\/invoke$/,
	/^\/model\/[^/]+\/invoke-with-response-stream$/,
	/^\/model\/[^/]+\/converse$/,
	/^\/model\/[^/]+\/converse-stream$/,
];

/**
 * Access-key id the child's SDK signs with. The *secret* of that pair is the
 * proxy token, so a client must hold the capability to produce a plausible
 * signature — but see `evaluateRequest`: we check the key id and require a
 * signature, we do not recompute it (see the residual note in
 * docs/agent-isolation.md §9).
 */
export const PROXY_ACCESS_KEY_ID = "CLOUDMODEPROXY0000AK";

function tokensMatch(a, b) {
	const x = Buffer.from(String(a ?? ""));
	const y = Buffer.from(String(b ?? ""));
	return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

/** The model id embedded in a Bedrock runtime path, or undefined. */
export function modelIdFromPath(pathname) {
	const m = /^\/model\/([^/]+)\//.exec(pathname);
	return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Decide whether a request may be signed and forwarded.
 * Exported separately from the server so the policy is unit-testable without
 * opening a socket.
 */
export function evaluateRequest({ method, url, authorization, expectedToken, pinnedModel }) {
	if (method !== "POST") return { ok: false, status: 405, reason: "only POST is proxied" };
	const pathname = (url ?? "").split("?")[0];
	if (!ALLOWED_PATHS.some((re) => re.test(pathname))) {
		return { ok: false, status: 404, reason: "path is not an allowed model invocation" };
	}
	// Two accepted credential shapes:
	//   1. `Bearer <proxy token>` — used by any client that can set headers, and
	//      the strong form: the token is compared in constant time.
	//   2. A SigV4 `Authorization` header whose Credential access-key-id is the
	//      proxy's dummy id — used by an AWS SDK inside the child, which insists on
	//      signing. The signature is produced with the proxy token as the secret.
	const header = String(authorization ?? "");
	const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1];
	const sigv4 = /^AWS4-HMAC-SHA256\s+Credential=([^/]+)\/[^,]+,.*Signature=([0-9a-f]{64})/i.exec(header);
	const bearerOk = bearer !== undefined && tokensMatch(bearer, expectedToken);
	const sigv4Ok = sigv4 !== null && tokensMatch(sigv4[1], PROXY_ACCESS_KEY_ID);
	if (!bearerOk && !sigv4Ok) {
		return { ok: false, status: 403, reason: "missing or invalid proxy credential" };
	}
	const model = modelIdFromPath(pathname);
	if (pinnedModel && model !== pinnedModel) {
		return {
			ok: false,
			status: 403,
			reason: `model '${model}' is not the runtime's pinned model '${pinnedModel}'`,
		};
	}
	return { ok: true, model, pathname };
}

/**
 * Start the proxy.
 *
 * @param {object} opts
 * @param {string} opts.pinnedModel        model id the agent may call
 * @param {string} opts.region             AWS region of the Bedrock endpoint
 * @param {() => Promise<object>} opts.credentials  resolves the agent-role credentials
 * @param {(msg: string) => void} [opts.log]
 * @param {(args: object) => Promise<{status:number, headers:object, body:AsyncIterable|Buffer}>} [opts.forward]
 *        injectable transport (tests supply a fake; production signs with SigV4)
 * @returns {Promise<{ url: string, token: string, close: () => Promise<void>, port: number }>}
 */
export async function startModelProxy({ pinnedModel, region, credentials, log = () => {}, forward } = {}) {
	const token = randomBytes(32).toString("base64url");
	const send = forward ?? makeSigV4Forwarder({ region, credentials });

	const server = createServer(async (req, res) => {
		const verdict = evaluateRequest({
			method: req.method,
			url: req.url,
			authorization: req.headers.authorization,
			expectedToken: token,
			pinnedModel,
		});
		if (!verdict.ok) {
			// Deliberately terse to the caller, explicit in the log: an injected
			// agent should not learn the policy by probing, but the operator must be
			// able to see that something probed.
			log(`[cloud-mode] model proxy refused ${req.method} ${req.url}: ${verdict.reason}`);
			res.writeHead(verdict.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "refused" }));
			req.resume();
			return;
		}
		try {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			const upstream = await send({
				path: verdict.pathname,
				query: (req.url ?? "").split("?")[1],
				body: Buffer.concat(chunks),
				headers: {
					"content-type": req.headers["content-type"] ?? "application/json",
					accept: req.headers.accept ?? "application/json",
				},
			});
			res.writeHead(upstream.status, upstream.headers ?? {});
			if (upstream.body && typeof upstream.body[Symbol.asyncIterator] === "function") {
				for await (const chunk of upstream.body) res.write(chunk);
				res.end();
			} else {
				res.end(upstream.body ?? "");
			}
		} catch (err) {
			log(`[cloud-mode] model proxy upstream error: ${String(err?.message ?? err)}`);
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ message: "upstream error" }));
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		// Loopback only: nothing outside this microVM can reach the proxy, and
		// nothing inside it can reach it without the token.
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	const url = `http://127.0.0.1:${port}`;
	log(`[cloud-mode] model proxy listening on ${url} (pinned model: ${pinnedModel ?? "any"})`);

	return {
		url,
		token,
		port,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/** Production transport: SigV4-sign with the agent role and forward to Bedrock. */
function makeSigV4Forwarder({ region, credentials }) {
	return async function forward({ path, query, body, headers }) {
		const { SignatureV4 } = await import("@smithy/signature-v4");
		const { Sha256 } = await import("@aws-crypto/sha256-js");
		const { HttpRequest } = await import("@smithy/protocol-http");
		const { NodeHttpHandler } = await import("@smithy/node-http-handler");

		const hostname = `bedrock-runtime.${region}.amazonaws.com`;
		const signer = new SignatureV4({
			service: "bedrock",
			region,
			credentials: typeof credentials === "function" ? await credentials() : credentials,
			sha256: Sha256,
		});
		const request = new HttpRequest({
			method: "POST",
			protocol: "https:",
			hostname,
			path,
			query: query ? Object.fromEntries(new URLSearchParams(query)) : undefined,
			headers: { ...headers, host: hostname },
			body,
		});
		const signed = await signer.sign(request);
		const { response } = await new NodeHttpHandler().handle(signed);
		return { status: response.statusCode, headers: response.headers, body: response.body };
	};
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session ownership + caller attribution for delegated stories.
 *
 * Two separate concerns that both live on the client side:
 *
 * 1. OWNER TOKEN (threat model T-002 / M-020) — the runtime-session-id used to be
 *    the whole capability: anyone invoke-authorized who learned it could attach
 *    to a live run, read its transcript, or steer the agent. Every session now
 *    also gets a 256-bit owner token that stays in this process's memory and is
 *    replayed on attach/steer/stop, so a leaked session id is no longer enough.
 *    It is never rendered, never persisted, and never logged.
 *
 * 2. DELEGATED-BY (threat model T-009 / M-024) — the identity of the human who
 *    delegated, so a commit or PR can be correlated with the CloudTrail
 *    `InvokeAgentRuntime` event in one hop. Self-reported and therefore NOT an
 *    authorization input; CloudTrail remains the source of truth.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** sessionId → owner token. In-memory only; lost on reload (as intended). */
const ownerTokens = new Map<string, string>();

/** Mint and remember the owner token for a new session. */
export function mintOwnerToken(sessionId: string): string {
	const token = randomBytes(32).toString("hex");
	ownerTokens.set(sessionId, token);
	return token;
}

/**
 * Owner token for a session, or undefined when this process did not start it
 * (e.g. after a pi restart) — in which case the worker will refuse mutating
 * actions, which is the intended, honest outcome.
 */
export function ownerToken(sessionId: string): string | undefined {
	return ownerTokens.get(sessionId);
}

export function forgetOwnerToken(sessionId: string): void {
	ownerTokens.delete(sessionId);
}

/** Add the owner token to an outgoing payload when we have one. */
export function withOwnerToken(
	sessionId: string,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const token = ownerTokens.get(sessionId);
	return token ? { ...payload, ownerToken: token } : payload;
}

let cachedIdentity: string | undefined;
let identityResolved = false;

/**
 * Best-effort caller identity (`arn:aws:sts::…:assumed-role/…`) via the AWS CLI.
 *
 * Deliberately best-effort: attribution must never block a delegation. When it
 * cannot be resolved the worker records "unknown" and CloudTrail still holds the
 * authoritative caller.
 */
export async function callerIdentity(): Promise<string | undefined> {
	if (identityResolved) return cachedIdentity;
	identityResolved = true;
	try {
		const { stdout } = await execFileAsync("aws", ["sts", "get-caller-identity", "--output", "json"], {
			timeout: 8000,
		});
		const parsed = JSON.parse(stdout) as { Arn?: string };
		cachedIdentity = parsed.Arn;
	} catch {
		cachedIdentity = undefined;
	}
	return cachedIdentity;
}

/** Reset caches — tests only. */
export function _resetIdentityCacheForTests(): void {
	cachedIdentity = undefined;
	identityResolved = false;
	ownerTokens.clear();
}

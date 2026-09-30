// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Durable transcript artifact per session.
 *
 * The worker's event history lives in memory and dies with the microVM, so after
 * a bad merge there is nothing left to reconstruct what the agent actually did.
 * At the end of every run we therefore write the full event stream — plus the
 * run's attribution metadata — to S3 as one JSONL object:
 *
 *   s3://<bucket>/<prefix>/<date>/<storyId>/<sessionId>.jsonl
 *
 * Best-effort by design: an upload failure must never fail a delivery that has
 * already happened, so it is logged loudly and swallowed. Objects are written
 * with the orchestrator identity (never the agent's), and the bucket the stack
 * creates is private, encrypted, versioned and lifecycle-expired.
 *
 * The transcript may quote proprietary code, which is why the bucket is
 * scoped to this account and retention is bounded. Credential-shaped strings are
 * masked on this write path (`redact.mjs`) so the audit trail cannot
 * itself become the easiest place to steal a secret; source code is deliberately
 * left intact, because redacting it would destroy the artifact's purpose.
 */

import { orchestratorCredentials } from "./aws-identity.mjs";
import { redactValue, serializeEvent } from "./redact.mjs";

const BUCKET = process.env.CLOUD_MODE_TRANSCRIPT_BUCKET?.trim();
const PREFIX = (process.env.CLOUD_MODE_TRANSCRIPT_PREFIX ?? "transcripts").replace(/^\/+|\/+$/g, "");

let clientPromise;
async function s3() {
	clientPromise ??= (async () => {
		const { S3Client } = await import("@aws-sdk/client-s3");
		return new S3Client({ region: process.env.AWS_REGION, credentials: orchestratorCredentials });
	})();
	return clientPromise;
}

/** Whether transcript archiving is configured for this runtime. */
export function transcriptArchivingEnabled() {
	return Boolean(BUCKET);
}

/** Object key for a session's transcript. */
export function transcriptKey({ storyId, sessionId, at = new Date() }) {
	const day = at.toISOString().slice(0, 10);
	// Story ids and session ids are client-supplied: keep them to a flat, safe
	// alphabet so they can never shape the key (no separators, no dot segments).
	const safe = (s) =>
		String(s ?? "unknown")
			.replace(/[^A-Za-z0-9._-]/g, "_")
			.replace(/\.{2,}/g, "_")
			.replace(/^[.-]+/, "_")
			.slice(0, 120) || "unknown";
	return `${PREFIX}/${day}/${safe(storyId)}/${safe(sessionId)}.jsonl`;
}

/**
 * Persist a session transcript. Returns { archived, uri?, error? } and never throws.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {object} args.meta      run metadata (storyId, repo, branch, delivery, caller, isolation posture)
 * @param {object[]} args.events  the hub's event history (already seq-stamped)
 * @param {(msg: string) => void} [args.log]
 */
export async function archiveTranscript({ sessionId, meta = {}, events = [], log = () => {} }) {
	if (!BUCKET) return { archived: false, reason: "no CLOUD_MODE_TRANSCRIPT_BUCKET configured" };
	const key = transcriptKey({ storyId: meta.storyId, sessionId });
	try {
		const header = {
			type: "cloud_transcript_header",
			sessionId,
			writtenAt: new Date().toISOString(),
			worker: { pi: process.env.PI_MODEL, provider: process.env.PI_PROVIDER },
			meta: redactValue(meta),
			eventCount: events.length,
			redaction: "credential-shaped strings masked; source code retained",
		};
		// One chokepoint: every event is redacted and size-capped here, so a newly
		// added event type cannot bypass the control.
		const body = [header, ...events].map((e) => serializeEvent(e)).join("\n") + "\n";
		const { PutObjectCommand } = await import("@aws-sdk/client-s3");
		await (
			await s3()
		).send(
			new PutObjectCommand({
				Bucket: BUCKET,
				Key: key,
				Body: body,
				ContentType: "application/x-ndjson",
				ServerSideEncryption: "AES256",
				Metadata: {
					storyid: String(meta.storyId ?? ""),
					repo: String(meta.repoNwo ?? ""),
					delegatedby: String(meta.delegatedBy ?? "unknown"),
				},
			}),
		);
		const uri = `s3://${BUCKET}/${key}`;
		log(`[cloud-mode] transcript archived: ${uri} (${events.length} events)`);
		return { archived: true, uri, key };
	} catch (err) {
		const message = String(err?.message ?? err);
		log(`[cloud-mode] TRANSCRIPT ARCHIVE FAILED (${BUCKET}/${key}): ${message}`);
		return { archived: false, error: message };
	}
}

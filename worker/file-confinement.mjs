// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

/**
 * Path confinement for the agent's file tools.
 *
 * Every LLM-issued *shell command* already runs as the unprivileged `cmagent`
 * user with an allow-listed environment. pi's built-in file
 * tools — read, write, edit, ls, grep, find — do not: they are in-process
 * functions that execute with the orchestrator's privileges. Until the agent
 * runs out-of-process, that leaves an injected agent three
 * cheap, high-value targets *without needing a shell at all*:
 *
 *   1. `/proc/self/environ` and `/proc/self/cmdline` — the orchestrator's own
 *      environment, historically including the GitHub installation token,
 *   2. the clone's `.git` directory — config, hooks, and the ability to rewrite
 *      what gets pushed after the validation gate passed,
 *   3. the askpass helper directory and any file outside the worktree
 *      (`~/.aws`, the image's own source, another session's scratch dir).
 *
 * This module wraps the tools' pluggable `operations` so that every path they
 * touch is resolved and checked against one rule: it must stay inside the
 * session worktree, and it must not be a denied subpath. Deny wins over allow.
 *
 * Design notes:
 *   - Confinement happens on the *resolved, symlink-aware* path. A relative
 *     path, a `..` traversal and a symlink pointing out of the worktree all
 *     collapse to the same check.
 *   - The check is applied to every operation, not just writes: reading
 *     `/proc/self/environ` is the credential-theft path, so reads are confined
 *     too.
 *   - Failures are loud and specific. The agent gets an error naming the rule,
 *     which is also what appears in the transcript — a visible signal that
 *     something tried to leave the worktree.
 */

import { existsSync, promises as fsp, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** Subpaths of the worktree the agent may never touch, even though they are inside it. */
const DENIED_WITHIN_WORKTREE = [".git"];

/**
 * Absolute prefixes that are denied regardless of the worktree, as defence in
 * depth for the case where a worktree is (mis)configured close to them.
 */
const DENIED_ABSOLUTE = ["/proc", "/sys", "/dev", "/run/secrets"];

export class PathConfinementError extends Error {
	constructor(message) {
		super(message);
		this.name = "PathConfinementError";
		this.code = "EPATHCONFINED";
	}
}

/** Resolve `p` as far as it exists, so a not-yet-created file still normalises. */
function resolveExisting(p) {
	let current = resolve(p);
	const tail = [];
	// Walk up until we find a path that exists, realpath that, then re-append.
	// This makes `write` to a new file inside a symlinked directory behave like a
	// write to the directory's real location.
	for (;;) {
		if (existsSync(current)) {
			try {
				return resolve(realpathSync(current), ...tail.reverse());
			} catch {
				return resolve(current, ...tail.reverse());
			}
		}
		const parent = resolve(current, "..");
		if (parent === current) return resolve(p);
		tail.push(current.slice(parent.length + 1));
		current = parent;
	}
}

function isWithin(child, parent) {
	if (child === parent) return true;
	return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Build a guard bound to one worktree.
 * Returns `assertAllowed(path)` → the resolved absolute path, or throws.
 */
export function makePathGuard(worktree, { deniedWithin = DENIED_WITHIN_WORKTREE, extraDenied = [] } = {}) {
	const root = resolveExisting(worktree);
	const deniedRoots = [
		...DENIED_ABSOLUTE.map((d) => resolve(d)),
		...extraDenied.filter(Boolean).map((d) => resolveExisting(d)),
	];
	const deniedInside = deniedWithin.map((rel) => resolve(root, rel));

	return function assertAllowed(candidate, { operation = "access" } = {}) {
		if (typeof candidate !== "string" || candidate === "") {
			throw new PathConfinementError(`${operation}: a file path is required`);
		}
		const target = resolveExisting(isAbsolute(candidate) ? candidate : resolve(root, candidate));

		for (const denied of deniedRoots) {
			if (isWithin(target, denied)) {
				throw new PathConfinementError(
					`${operation} denied: '${candidate}' resolves into '${denied}', which the agent may never read or write. ` +
						`Work inside the repository worktree instead.`,
				);
			}
		}
		for (const denied of deniedInside) {
			if (isWithin(target, denied)) {
				throw new PathConfinementError(
					`${operation} denied: '${candidate}' resolves into the repository's '.git' directory. ` +
						`Git operations are performed by the pipeline, not by the agent.`,
				);
			}
		}
		if (!isWithin(target, root)) {
			throw new PathConfinementError(
				`${operation} denied: '${candidate}' resolves to '${target}', which is outside the session worktree ` +
					`'${root}'. The agent may only read and write files in the repository it was given.`,
			);
		}
		return target;
	};
}

/**
 * Confined `operations` objects for pi's file tools. Each mirrors the default
 * local-filesystem behaviour, with the guard applied first.
 */
export function confinedFileOperations(worktree, options = {}) {
	const assertAllowed = makePathGuard(worktree, options);

	const read = {
		readFile: async (p) => fsp.readFile(assertAllowed(p, { operation: "read" })),
		access: async (p) => fsp.access(assertAllowed(p, { operation: "read" })),
	};

	const write = {
		writeFile: async (p, content) => fsp.writeFile(assertAllowed(p, { operation: "write" }), content),
		mkdir: async (dir) => {
			await fsp.mkdir(assertAllowed(dir, { operation: "mkdir" }), { recursive: true });
		},
	};

	const edit = {
		readFile: async (p) => fsp.readFile(assertAllowed(p, { operation: "edit" })),
		writeFile: async (p, content) => fsp.writeFile(assertAllowed(p, { operation: "edit" }), content),
		access: async (p) => fsp.access(assertAllowed(p, { operation: "edit" })),
	};

	const ls = {
		exists: (p) => existsSync(assertAllowed(p, { operation: "ls" })),
		stat: (p) => statSync(assertAllowed(p, { operation: "ls" })),
		readdir: async (p) => fsp.readdir(assertAllowed(p, { operation: "ls" })),
	};

	const grep = {
		isDirectory: (p) => statSync(assertAllowed(p, { operation: "grep" })).isDirectory(),
		readFile: async (p) => (await fsp.readFile(assertAllowed(p, { operation: "grep" }))).toString(),
	};

	return { assertAllowed, read, write, edit, ls, grep };
}

/**
 * The find tool globs inside a cwd rather than touching named paths, so the
 * guard is applied to the cwd and to every returned hit.
 */
export function confinedFindOperations(worktree, options = {}) {
	const assertAllowed = makePathGuard(worktree, options);
	return {
		exists: (p) => existsSync(assertAllowed(p, { operation: "find" })),
		glob: async (pattern, cwd, globOptions) => {
			const safeCwd = assertAllowed(cwd, { operation: "find" });
			const { glob } = await import("node:fs/promises").then((m) => ({ glob: m.glob }));
			const hits = [];
			const limit = globOptions?.limit ?? 1000;
			for await (const hit of glob(pattern, { cwd: safeCwd })) {
				try {
					assertAllowed(resolve(safeCwd, hit), { operation: "find" });
				} catch {
					continue; // a symlinked hit pointing out of the worktree is dropped
				}
				hits.push(hit);
				if (hits.length >= limit) break;
			}
			return hits;
		},
	};
}

# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# Cloud Mode worker image — Bedrock AgentCore Runtime contract wrapping pi.
#
# Serves the AgentCore container contract (GET /ping, POST /invocations →
# text/event-stream). Must be arm64 and listen on :8080 (AgentCore requirement).
# Contains Node.js, Git, GitHub CLI, and the pi SDK.
# Base image comes from ECR Public (public.ecr.aws/docker/library/...), NOT Docker
# Hub: BuilderHub container guidelines require images to be pulled from an
# AWS-owned registry rather than an external third-party repository
# (Bosco/ACAT `non-ecr-docker-image`; Aristotle implementations 367/368,
# recommendation 118). ECR Public mirrors the Docker official images — the arm64
# manifest digest behind this index is identical to the Docker Hub one
# (sha256:253da19867dd03e2f817f433d7782adefd2a2bac8729fcd4ebc6770665167a24).
#
# Pinned by DIGEST, not by tag: a tag is mutable, so
# `cdk deploy` could otherwise silently ship a different base image than the one
# that was reviewed and scanned. Refresh deliberately with:
#   docker pull --platform linux/arm64 public.ecr.aws/docker/library/node:22-bookworm-slim \
#     && docker image inspect public.ecr.aws/docker/library/node:22-bookworm-slim \
#          --format '{{index .RepoDigests 0}}'
FROM public.ecr.aws/docker/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

# System deps: git, gh, curl, ca-certificates (openssl ships with the base image;
# GitHub App JWT signing is done in-process with Node's crypto). `util-linux`
# provides `setpriv`, which is how untrusted code is dropped to an unprivileged
# user. `sudo` is kept as a
# fallback for platforms that permit setuid binaries.
#
# `dist-upgrade` pulls Debian security updates published after the base image was
# built — without it the image ships whatever CVEs the base has accumulated, which
# ECR scan-on-push then reports on every deploy.
#
# The second `dist-upgrade` + assertion below is not redundant. It closes a gap
# that a real ECR scan found: the base-image pin can be perfectly current while
# Debian has published package fixes *since this image was last built*, and the
# packages pulled in as dependencies of `git`/`curl`/`gh` are resolved after the
# first upgrade ran. A cached layer makes it worse — the upgrade appears to have
# run but its index is weeks old. The deployed image was 10 HIGH findings stale
# that way (libssh2, expat, pcre2) while every scheduled check was green.
# Asserting "no pending upgrades" at BUILD time makes that state unshippable
# instead of merely reported.
RUN apt-get update && apt-get -y --no-install-recommends dist-upgrade \
    && apt-get install -y --no-install-recommends \
      git curl ca-certificates gnupg sudo util-linux \
    && mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && apt-get -y --no-install-recommends dist-upgrade \
    && pending="$(apt-get -s dist-upgrade | grep '^Inst' || true)" \
    && if [ -n "$pending" ]; then \
         echo "BUILD REFUSED: packages still behind their candidate version:" >&2; \
         echo "$pending" >&2; \
         echo "An image that ships a fix it could have taken is a finding, not a residual." >&2; \
         echo "Rebuild with --no-cache (a cached layer means a stale apt index)." >&2; \
         exit 1; \
       fi \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Project toolchains ──────────────────────────────────────────────────────
# The agent clones and BUILDS + TESTS the target project inside this container
# (the validation gate runs here before pushing). Install every compiler,
# runtime, package manager, and system library your project needs to compile and
# test, or that step is silently skipped and the agent can't run your build/test
# commands. The image is arm64 — choose arm64 builds for anything you add, and
# redeploy the runtime after changing this (`cd cdk && npx cdk deploy`). Example:
#
#   RUN apt-get update && apt-get install -y --no-install-recommends \
#         python3 python3-pip python3-venv \   # Python
#         openjdk-17-jdk maven \               # JVM
#         build-essential pkg-config libssl-dev # native deps / headers
#       && rm -rf /var/lib/apt/lists/*
#   # Non-apt toolchains (install onto a PATH the non-root `node` user can see):
#   # RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y   # Rust
#   # RUN curl -fsSL https://go.dev/dl/go1.22.linux-arm64.tar.gz | tar -C /usr/local -xz
# ────────────────────────────────────────────────────────────────────────────

# Install the pinned pi SDK (design decision #1) as a local dependency so the
# runtime server can `import` it.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Worker sources. Copied explicitly (not `COPY . .`) so nothing unexpected from
# the build context lands in the image. Every new module must be listed here —
# a missing one only fails at container start, so `tests/sandbox-container.sh`
# and the deploy smoke test are what catch it.
COPY server.mjs git.mjs git-auth.mjs secrets.mjs integrate.mjs llm-resolver.mjs llm-repair.mjs \
     validate.mjs aws-identity.mjs sandbox.mjs hub.mjs session-guard.mjs transcript-archive.mjs \
     gating.mjs file-confinement.mjs redact.mjs \
     agent-ipc.mjs agent-host.mjs agent-child.mjs model-proxy.mjs ./

# ── Privilege separation inside the session ──────
# Two OS identities share this container:
#   root    — the ORCHESTRATOR: holds the GitHub installation token (in memory,
#             handed to git via GIT_ASKPASS) and resolves AWS credentials.
#   cmagent — UNTRUSTED code: every shell command the LLM runs and every
#             build/test script the target repository supplies.
#
# Why the orchestrator runs as root: Bedrock AgentCore does not permit setuid
# escalation inside the container (`sudo` fails), so a non-root process cannot
# switch to another user at all. Dropping privileges DOWNWARD is always allowed,
# so the orchestrator stays root and uses `setpriv` to run untrusted code as
# cmagent. The trade-off is deliberate: root here lives inside a disposable,
# per-session microVM and holds no more AWS authority than before, while
# the code that attackers can actually influence now runs unprivileged, with no
# credentials in its environment and no access to the orchestrator's process
# state. `cmwork` is the shared group that lets both sides write the worktree
# (umask 002 is applied by sandbox.mjs).
RUN groupadd -r cmwork \
    && useradd -m -s /bin/bash -g cmwork cmagent \
    && printf 'root ALL=(cmagent) NOPASSWD: ALL\n' > /etc/sudoers.d/cloud-mode \
    && chmod 0440 /etc/sudoers.d/cloud-mode \
    && chmod 0700 /root \
    && chmod 0750 /home/cmagent \
    && mkdir -p /opt/cloud-mode-nohooks \
    && chmod 0755 /opt/cloud-mode-nohooks \
    # Shared, group-writable tool caches: either identity can populate them, so
    # the validation gate does not need a per-user cold corepack/npm cache.
    && mkdir -p /opt/cloud-mode-cache/corepack /opt/cloud-mode-cache/npm /opt/cloud-mode-cache/xdg \
    && chgrp -R cmwork /opt/cloud-mode-cache \
    && chmod -R 2777 /opt/cloud-mode-cache

# Enable corepack (bundled with Node ≥16) as root so the pnpm/yarn shims land
# on PATH for BOTH runtime users. The auto-detecting validation gate
# (validate.mjs) then resolves each repo's pinned package manager at run time
# from its `packageManager` field / lockfile.
RUN corepack enable

# AgentCore requires the container to listen on :8080.
ENV PORT=8080
# Shared caches for untrusted builds (see sandbox.mjs allow-list).
ENV COREPACK_HOME=/opt/cloud-mode-cache/corepack \
    npm_config_cache=/opt/cloud-mode-cache/npm \
    XDG_CACHE_HOME=/opt/cloud-mode-cache/xdg
EXPOSE 8080

# The orchestrator runs as root ONLY so it can drop privileges for untrusted
# code (see above); everything the LLM or a repository can influence is executed
# as `cmagent` by sandbox.mjs. If a future platform allows setuid again, set
# USER node and the sudo strategy takes over automatically.
RUN chmod -R go-w /app
USER root

CMD ["node", "server.mjs"]

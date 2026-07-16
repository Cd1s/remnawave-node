# AI maintainer guide

## Repository role

This is the Node runtime fork for the Remnawave dual-core project.

- Fork: `Cd1s/remnawave-node`
- Maintained branch: `singbox`
- Upstream: `remnawave/node` branch `main`
- Published artifact: `ghcr.io/cd1s/remnawave-node`

This repository owns execution of the selected proxy core, runtime lifecycle, dynamic user
operations, health metadata, and traffic statistics. The backend owns configuration preparation
and orchestration; the frontend must not define runtime behavior.

The cross-repository source of truth is
[`Cd1s/remnawave-singbox`](https://github.com/Cd1s/remnawave-singbox). Read its project map,
feature registry, and upstream maintenance guide before changing commands shared with the backend.

## Fork-specific behavior

The `singbox` branch adds:

- Xray/sing-box core selection while retaining the original Node API surface;
- a sing-box binary in the multi-architecture image;
- s6 lifecycle and logging services for sing-box;
- atomic config writing and `sing-box check` before activation;
- user add/remove handling through config mutation and controlled reload;
- traffic accumulation across sing-box reloads;
- core-aware health and version metadata;
- automatic upstream synchronization and fork image publication.

Important implementation areas include:

- `src/modules/core/`
- `src/modules/handler/`
- `src/modules/stats/`
- `src/modules/internal/internal.service.ts`
- `src/modules/xray-core/`
- `rootfs/etc/s6-overlay/s6-rc.d/sing-box/`
- `rootfs/etc/s6-overlay/s6-rc.d/sing-box-log/`
- `rootfs/etc/s6-overlay/scripts/init-env.sh`
- `Dockerfile`

Before changing fork behavior, inspect the real delta:

```bash
git diff --name-status upstream/main...HEAD
git log --oneline upstream/main..HEAD
```

## Compatibility invariants

1. Existing Xray Nodes start, stop, report health, manage users, and report traffic as before.
2. Existing backend routes and payload fields remain accepted.
3. Only the selected managed core runs for a profile.
4. sing-box configuration is written atomically and validated before reload.
5. Failed sing-box validation does not replace a known-good running configuration.
6. User add/remove operations preserve all unrelated inbounds and users.
7. Traffic already collected before a reload is not lost or double-counted.
8. Health responses identify the active core and version while preserving legacy fallbacks.
9. Image builds remain available for `linux/amd64` and `linux/arm64`.

## How to add a custom feature

Register the feature in the central `docs/custom-feature-registry.md` and identify its backend
command/config requirements before implementation.

Prefer:

- core-specific services behind a small common dispatch boundary;
- capability checks and optional command fields;
- additive s6 services;
- atomic files and explicit validation;
- deterministic runtime tests for reload, user count, and traffic behavior.

Avoid:

- placing sing-box branches throughout unrelated Xray services when a core adapter can own them;
- changing an existing command in a way an older backend cannot tolerate;
- process replacement without a rollback path;
- downloading unpinned binaries during container startup;
- embedding deployment credentials or node addresses in the image.

If upstream adds a core abstraction, migrate toward it and keep only the sing-box-specific adapter.
Do not retain two competing lifecycle managers.

## Upstream synchronization failure

The scheduled workflow merges upstream in a temporary checkout, builds, traces the application,
checks fork-modified files, and pushes only a tested merge. Failure leaves `origin/singbox`
unchanged.

Repair procedure:

1. Create a temporary branch from `origin/singbox`.
2. Merge `upstream/main`; do not rebase or force-push the maintained branch.
3. Resolve conflicts with special attention to Node commands, Xray lifecycle, handler semantics,
   stats collection, s6 services, and the Dockerfile.
4. Compare the final core dispatch with both the old fork and new upstream flow.
5. Run the validation gates and a real isolated AnyTLS transfer.
6. Test dynamic user transitions and traffic collection across a sing-box reload.
7. Confirm an Xray profile still runs on the forked image.
8. Merge the repair into `singbox`; let CI publish the image.

## Validation gates

Use Node.js 24 and run:

```bash
npm ci --no-audit --no-fund
npm run build
npm run trace
```

Also mirror the workflow's format/lint checks for files changed relative to `upstream/main`. For
runtime changes, run the Node adapter and full-stack isolated validations documented in the central
repository.

## Definition of done

A Node change is complete only when:

- Xray compatibility and sing-box behavior are both tested;
- process failure and rollback behavior are known;
- backend command compatibility is confirmed;
- amd64 and arm64 image builds remain valid;
- the central feature registry is updated when behavior changes;
- no secrets or infrastructure identifiers are committed.

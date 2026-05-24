# Releasing from `parachute-hub`

This repo publishes TWO npm packages on independent release cadences via [`.github/workflows/release.yml`](./.github/workflows/release.yml):

| Package | Tag prefix | Container image |
|---|---|---|
| `@openparachute/hub` | `v...` (e.g. `v0.5.13-rc.33`) | yes — `ghcr.io/parachutecomputer/parachute-hub` |
| `@openparachute/scope-guard` | `scope-guard-v...` (e.g. `scope-guard-v0.4.0`) | no |

Pushing a tag triggers CI which runs `bun run typecheck` + `bun test ./src`, then publishes the package matching the tag prefix.

## Tag conventions

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Example | npm `dist-tag` | ghcr image tags (hub only) |
|---|---|---|---|
| `vX.Y.Z-rc.N` | `v0.5.13-rc.33` | `rc` | `:v0.5.13-rc.33`, `:rc` |
| `vX.Y.Z` | `v0.5.13` | `latest` | `:v0.5.13`, `:stable` |
| `scope-guard-vX.Y.Z-rc.N` | `scope-guard-v0.4.0-rc.2` | `rc` | — |
| `scope-guard-vX.Y.Z` | `scope-guard-v0.4.0` | `latest` | — |

The workflow auto-detects rc vs stable from the `-rc.` substring in the tag.

## Release flow

Per [governance rule 2 (updated 2026-05-24)](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md), PRs do NOT bump version per-commit. Bump + tag together only when you intend to ship.

### Releasing hub

```sh
git fetch && git checkout main && git pull --ff-only
# Bump the version in ./package.json (rc.N or drop -rc for stable), commit, push.
VERSION="v$(bun -e "console.log(require('./package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-hub/actions). On success:
- npm gets the new version with appropriate dist-tag
- ghcr gets a new image at `:vX.Y.Z` plus `:rc` or `:stable`

### Releasing scope-guard

```sh
git fetch && git checkout main && git pull --ff-only
# Bump the version in ./packages/scope-guard/package.json, commit, push.
VERSION="scope-guard-v$(bun -e "console.log(require('./packages/scope-guard/package.json').version)")"
git tag "$VERSION"
git push origin "$VERSION"
```

The hub package is NOT republished. scope-guard runs on its own cadence.

### Promoting an rc chain to stable

Open a PR (or commit directly) that drops the `-rc.N` suffix from the relevant `package.json`, merge, then tag the bare version. CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs DO NOT bump version. They merge straight to main; the changes get folded into whatever the next ship-driven version bump captures.

## One-time setup (operator)

Before the workflow can publish, this repo needs:

1. **npm Trusted Publishers — one per published package**:
   - npmjs.com → `@openparachute/hub` → Settings → Trusted Publishers → add GitHub Actions: `ParachuteComputer` / `parachute-hub` / `release.yml` / env blank
   - npmjs.com → `@openparachute/scope-guard` → same Trusted Publisher (same org/repo/workflow/env)

   Both rules point at the SAME workflow file. The jobs gate on tag prefix to decide which package to publish. No `NPM_TOKEN` secret needed — the workflow uses OIDC.

2. **ghcr.io permissions**: no secret needed — the workflow uses the runner's auto-provisioned `GITHUB_TOKEN`. First push of the image will create the package as **private by default**. After that first push, go to [package settings](https://github.com/orgs/ParachuteComputer/packages/container/parachute-hub/settings) → "Change visibility" → **Public**. Until you do this, any deploy target that pulls the image (Render, etc.) will 403 on `docker pull` unless you supply a `GHCR_PAT` read token. Doing it once at first-push time is the simplest path.

## Verifying a release

```sh
# npm
npm view @openparachute/hub@<version> dist.tarball
npm view @openparachute/hub dist-tags
npm view @openparachute/scope-guard dist-tags

# ghcr (hub only)
docker pull ghcr.io/parachutecomputer/parachute-hub:<tag>
docker inspect ghcr.io/parachutecomputer/parachute-hub:<tag> | jq '.[].Config.Labels'
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path for either npm (npm has a strict 72-hour unpublish policy that you should avoid for published packages anyway) or ghcr (containers are append-only). To roll back:

- Cut a new patch from a known-good commit (e.g. `0.5.13` → `0.5.14` reverting the bad change).
- Optionally re-point `:stable` ghcr tag to an older image so existing deploys pull the safe version. If you've already pruned the older image locally, pull it first:
  ```sh
  docker pull ghcr.io/parachutecomputer/parachute-hub:v0.5.10
  docker tag ghcr.io/parachutecomputer/parachute-hub:v0.5.10 ghcr.io/parachutecomputer/parachute-hub:stable
  docker push ghcr.io/parachutecomputer/parachute-hub:stable
  ```

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches one of the patterns in `on.push.tags` (hub: `v[0-9]+...`; scope-guard: `scope-guard-v[0-9]+...`).
- **`version mismatch` error in publish-npm**: the relevant `package.json` version differs from the tag. Re-tag the correct commit, or fix the version in `package.json`.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-hub` / `release.yml`. If the workflow file was renamed, the rule needs updating on npm.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
- **ghcr push fails with 403**: confirm `permissions.packages: write` is in the publish-image job (it is).
- **Two publish jobs running for the same tag**: the `if:` gates filter by `startsWith(github.ref_name, 'scope-guard-')` — verify the tag matches exactly one prefix.

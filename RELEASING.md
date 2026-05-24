# Releasing `@openparachute/hub`

Releases are automated via [`.github/workflows/release.yml`](./.github/workflows/release.yml). Pushing a git tag triggers CI which:

1. Runs `bun run typecheck` + `bun test ./src`
2. Publishes to npm (with provenance attestation)
3. Builds + pushes a container image to `ghcr.io/parachutecomputer/parachute-hub`

## Tag conventions

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Example | npm `dist-tag` | ghcr tags |
|---|---|---|---|
| `vX.Y.Z-rc.N` | `v0.5.13-rc.33` | `rc` | `:v0.5.13-rc.33`, `:rc` |
| `vX.Y.Z` | `v0.5.13` | `latest` | `:v0.5.13`, `:stable` |

The workflow auto-detects rc vs stable from the tag string (`-rc.` substring).

## Release flow

### For an rc bump (each code-touching PR merge)

After your PR merges to `main` with a bumped `rc.N`:

```sh
git fetch && git checkout main && git pull --ff-only
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-hub/actions).

### Promoting an rc chain to stable

When the rc chain is ready to release:

1. Open a PR that drops the `-rc.N` suffix from `package.json` (e.g. `0.5.13-rc.33` → `0.5.13`).
2. Reviewer + merge as usual.
3. Tag the merged commit with the bare version: `git tag v0.5.13 && git push origin v0.5.13`.
4. CI publishes with `dist-tag=latest` and `ghcr` tag `:stable`.

### Doc-only PRs

Per governance, doc-only PRs are EXEMPT from rc.N bumping — they merge without a version bump and get picked up by the next code-touching PR's rc bump (or by the stable promotion, whichever comes first). Don't fragment a release into many patch bumps mid-validation.

If you DO need to ship a doc-only fix outside an active rc chain (i.e. main is on a stable version with no rc.N in flight), bump the next patch (`0.5.13` → `0.5.14`), tag, ship.

## One-time setup (operator)

Before the workflow can publish, this repo needs:

1. **`NPM_TOKEN` secret**: log into npmjs.com → Access Tokens → New Token (type: **Automation**) → scope to `@openparachute/*` packages. Add as `NPM_TOKEN` in [repo settings → Secrets and variables → Actions](https://github.com/ParachuteComputer/parachute-hub/settings/secrets/actions).

2. **ghcr.io permissions**: no secret needed — the workflow uses the runner's auto-provisioned `GITHUB_TOKEN`. First push of the image will create the package as **private by default**. After that first push, go to [package settings](https://github.com/orgs/ParachuteComputer/packages/container/parachute-hub/settings) → "Change visibility" → **Public**. Until you do this, any deploy target that pulls the image (Render, etc.) will 403 on `docker pull` unless you supply a `GHCR_PAT` read token. Doing it once at first-push time is the simplest path.

## Verifying a release

```sh
# npm
npm view @openparachute/hub@<version> dist.tarball
npm view @openparachute/hub dist-tags

# ghcr
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

- **Workflow doesn't trigger**: confirm the tag matches the workflow's `on.push.tags` pattern (`v[0-9]+.[0-9]+.[0-9]+` or `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`).
- **`version mismatch` error in publish-npm**: package.json version differs from the tag. Re-tag the correct commit.
- **`npm ERR! 403`**: `NPM_TOKEN` secret missing, expired, or has wrong scope. Regenerate.
- **ghcr push fails with 403**: confirm `permissions.packages: write` is in the workflow (it is).

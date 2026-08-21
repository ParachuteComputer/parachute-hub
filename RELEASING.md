# Releasing from `parachute-hub`

This repo publishes FOUR npm packages on independent release cadences via [`.github/workflows/release.yml`](./.github/workflows/release.yml):

| Package | Git tag prefix (recorded by CI; also accepted as a manual release trigger) | Container image |
|---|---|---|
| `@openparachute/hub` | `v...` (e.g. `v0.5.13-rc.33`) | yes — `ghcr.io/parachutecomputer/parachute-hub` |
| `@openparachute/scope-guard` | `scope-guard-v...` (e.g. `scope-guard-v0.4.0`) | no |
| `@openparachute/depcheck` | `depcheck-v...` (e.g. `depcheck-v0.1.1`) | no |
| `@openparachute/door-contract` | `door-contract-v...` (e.g. `door-contract-v0.6.0`) | no |

**Merging a version bump to `main` is the release signal** (hub#790). CI runs `bun run typecheck` + the four test suites once, then `scripts/release-plan.ts` compares each `package.json` against npm and publishes whatever is new. Nothing is tagged by hand — the `tag-record` job pushes `vX.Y.Z` afterwards as a record of what shipped.

Pushing a tag still works for a deliberate re-release of an **already-published** version: the image republishes (npm rejects republishing an existing version, so the npm job goes red — expected). A tag does **not** bypass `release-plan.ts`'s guards: the workflow never passes `--tag-push`, so an unpublished-older version or an ambiguous registry response fails the plan job and skips every publish (hub#841 tracks whether to wire the override). The merge path is the normal one.

## Version conventions

Per [governance rule 2](https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md):

| `package.json` version | Example | npm `dist-tag` | Recorded git tag | ghcr image tags (hub only) |
|---|---|---|---|---|
| hub `X.Y.Z-rc.N` | `0.7.14-rc.1` | `rc` | `v0.7.14-rc.1` | `:v0.7.14-rc.1`, `:rc` |
| hub `X.Y.Z` | `0.7.14` | `latest` | `v0.7.14` | `:v0.7.14`, `:stable`, `:latest` |
| scope-guard `X.Y.Z-rc.N` | `0.4.0-rc.2` | `rc` | `scope-guard-v0.4.0-rc.2` | — |
| scope-guard `X.Y.Z` | `0.4.0` | `latest` | `scope-guard-v0.4.0` | — |
| depcheck `X.Y.Z-rc.N` | `0.1.1-rc.1` | `rc` | `depcheck-v0.1.1-rc.1` | — |
| depcheck `X.Y.Z` | `0.1.1` | `latest` | `depcheck-v0.1.1` | — |
| door-contract `X.Y.Z-rc.N` | `0.7.0-rc.1` | `rc` | `door-contract-v0.7.0-rc.1` | — |
| door-contract `X.Y.Z` | `0.7.0` | `latest` | `door-contract-v0.7.0` | — |

rc vs stable is detected from the `-rc.` substring in **the version being published**, never from the ref — on a merge-triggered run the ref is `main`, which matches no version pattern at all. Reading the ref is what once put `0.7.9-rc.3` on `@latest` (hub#792) and what left merge-published images with a bare `:stable` and no `:vX.Y.Z` (hub#829).

## Release flow

Per [governance rule 2 (updated 2026-05-24)](https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md), feature PRs do NOT bump version. A release PR does, and merging it publishes.

### Releasing hub

```sh
git fetch && git checkout -b release/hub-X.Y.Z origin/main
# Bump the version in ./package.json (rc.N or drop -rc for stable) + CHANGELOG.
git commit -am "chore(release): hub X.Y.Z — <what shipped>"
gh pr create
```

Merge it to `main`. CI takes over — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-hub/actions). On success:
- npm gets the new version with the appropriate dist-tag
- ghcr gets a new image at `:vX.Y.Z` plus `:rc`, or `:stable` + `:latest`
- a `vX.Y.Z` git tag is pushed as a record

### Releasing scope-guard / depcheck / door-contract

Same shape: bump the version in `./packages/<name>/package.json` and merge. Each package's publish job gates on its own `plan` output, so bumping one publishes only that one — but a single merge that bumps several publishes all of them. The hub package is NOT republished unless its own version moved.

`@openparachute/door-contract` is the shared OAuth-issuer + `/account/*` wire contract both doors implement. Hub consumes it as a real npm dependency (`^0.7.0`) as of #826 — it used to be a `workspace:*` dep, which was unresolvable in the published hub tarball since `packages/` isn't shipped. So a door-contract change that hub depends on needs **two** releases: publish door-contract first, then bump hub's dependency range and release hub.

### Promoting an rc chain to stable

Open a release PR that drops the `-rc.N` suffix from the relevant `package.json` and merge it. CI publishes with `dist-tag=latest` (and, for hub, moves `:stable` + `:latest` on ghcr).

### Doc-only PRs

Per governance, doc-only PRs DO NOT bump version. They merge straight through; the changes get folded into whatever the next ship-driven version bump captures.

## One-time setup (operator)

Before the workflow can publish, this repo needs:

1. **npm Trusted Publishers — one per published package** (OIDC is scoped per package, so each needs its OWN rule or the publish job 404s on provenance):
   - npmjs.com → `@openparachute/hub` → Settings → Trusted Publishers → add GitHub Actions: `ParachuteComputer` / `parachute-hub` / `release.yml` / env blank
   - npmjs.com → `@openparachute/scope-guard` → same Trusted Publisher (same org/repo/workflow/env)
   - npmjs.com → `@openparachute/depcheck` → same Trusted Publisher (same org/repo/workflow/env)
   - npmjs.com → `@openparachute/door-contract` → same Trusted Publisher (same org/repo/workflow/env). **Required before the first `door-contract-v*` tag can publish.**

   All rules point at the SAME workflow file. The jobs gate on tag prefix to decide which package to publish. No `NPM_TOKEN` secret needed — the workflow uses OIDC.

2. **ghcr.io permissions**: no secret needed — the workflow uses the runner's auto-provisioned `GITHUB_TOKEN`.

   **The `parachute-hub` container package is `private`, deliberately, and stays that way until something outside this org needs to pull it.** Private costs one `docker login` for the verify/rollback steps below; public is a one-way-ish door on a package nobody currently deploys from. When a deploy target does need it (Render, a customer box), flip it once: [package settings](https://github.com/orgs/ParachuteComputer/packages/container/parachute-hub/settings) → "Change visibility" → **Public**. Until then, an unauthenticated `docker pull` 403s — that's expected, not a broken release.

## Verifying a release

```sh
# npm
npm view @openparachute/hub@<version> dist.tarball
npm view @openparachute/hub dist-tags
npm view @openparachute/scope-guard dist-tags
npm view @openparachute/depcheck dist-tags
npm view @openparachute/door-contract dist-tags

# ghcr (hub only). The package is private — authenticate first with a PAT
# carrying `read:packages`:
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
docker pull ghcr.io/parachutecomputer/parachute-hub:v<version>
docker inspect ghcr.io/parachutecomputer/parachute-hub:v<version> | jq '.[].Config.Labels'
```

Every publish pushes a versioned `:vX.Y.Z` tag alongside the moving `:rc` / `:stable` / `:latest` ones, so `docker pull …:v<version>` resolves for merge-published releases too (hub#829). The OCI `org.opencontainers.image.version` label carries the same version — if `docker inspect` shows `stable` there, the image predates that fix.

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path for either npm (npm has a strict 72-hour unpublish policy that you should avoid for published packages anyway) or ghcr (containers are append-only). To roll back:

- Cut a new patch from a known-good commit (e.g. `0.5.13` → `0.5.14` reverting the bad change).
- Optionally re-point the moving ghcr tags at an older image so existing deploys pull the safe version. Re-point `:latest` as well as `:stable` — both move on a stable publish. If you've already pruned the older image locally, pull it first:
  ```sh
  docker pull ghcr.io/parachutecomputer/parachute-hub:v0.5.10
  for MOVING in stable latest; do
    docker tag ghcr.io/parachutecomputer/parachute-hub:v0.5.10 \
               "ghcr.io/parachutecomputer/parachute-hub:$MOVING"
    docker push "ghcr.io/parachutecomputer/parachute-hub:$MOVING"
  done
  ```

## Troubleshooting

- **Workflow ran but nothing published**: the `plan` job decided there was nothing to do — read its log. `<pkg>@<version> is already on npm` means the version wasn't bumped. `plan` also warns (never fails) when commits sit on `main` that no published version contains; that warning is the cue to cut a release PR.
- **`plan` failed with "refusing to guess" / "is OLDER than the current"**: an ambiguous npm response, or two release PRs merged out of version order so the merge would move a dist-tag backwards. Bump past the published version and re-merge.
- **Workflow doesn't trigger at all**: for the merge path, confirm the merge landed on `main`. For a tag push, confirm the tag matches one of the patterns in `on.push.tags` (hub: `v[0-9]+...`; scope-guard: `scope-guard-v[0-9]+...`; depcheck: `depcheck-v[0-9]+...`; door-contract: `door-contract-v[0-9]+...`).
- **`version mismatch` error in publish-npm**: tag path only — the relevant `package.json` version differs from the tag. Re-tag the correct commit, or fix the version in `package.json`.
- **Image published with no `:vX.Y.Z` tag**: pre-hub#829 behaviour, where the image tags came from the ref (`main` on a merge run). Fixed by deriving every tag from `plan`'s `hub_version`.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-hub` / `release.yml`. If the workflow file was renamed, the rule needs updating on npm.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
- **ghcr push fails with 403**: confirm `permissions.packages: write` is in the publish-image job (it is).
- **Two publish jobs running for the same tag**: the `if:` gates filter by tag prefix (`scope-guard-`, `depcheck-`, `door-contract-`; a bare `v*` is hub's) — verify the tag matches exactly one prefix.

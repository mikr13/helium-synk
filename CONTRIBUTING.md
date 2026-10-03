# Contributing

## Commits and changesets

Use Conventional Commits for each coherent completed step, for example `feat(core): persist encrypted outgoing records`, `fix(server): reject conflicting retries`, or `docs: record compatibility evidence`. Use `!` plus a `BREAKING CHANGE:` footer for breaking behavior.

Install the repository-local commit hook with `pnpm hooks:install`. CI also validates commit messages on pull requests. Keep runtime changes, tests, and their changeset together.

Run `pnpm changeset` for user-visible changes. Select the affected private packages; write concise behavior-oriented notes with material limitations. Documentation/tooling-only changes do not need a release bump. Before 1.0, choose a minor bump for incompatible public/protocol changes and explicitly describe compatibility. Patch bumps cover compatible fixes.

## Checks

```sh
pnpm exec vp install --frozen-lockfile
pnpm exec vp run check
pnpm exec vp run check:server
pnpm exec vp run check:versions
pnpm exec vp run test:integration
pnpm exec vp run check:deployment
```

Do browser compatibility tests in disposable profiles. Never point test adapters at the user's normal bookmarks/history. Mark plan gates complete only with recorded evidence.

## Interface conventions

Use the shared dark-only Tailwind theme and shadcn/ui components for every interface. Keep all corners square and use the logo's navy/blue/mint tokens. Import extension source with `@/…`; use `@helium-synk/core` for the shared workspace package. Keep TypeScript, WXT and Vite+ test alias mappings aligned. See [the design system](docs/architecture.md#interface) for component, font and accessibility conventions.

## Release procedure

1. Review pending `.changeset/*.md` entries with `pnpm changeset status`.
2. On a release branch, run `pnpm version-packages`. It generates per-package CHANGELOG.md files, updates package versions, synchronizes the Rust crate version, and refreshes lockfiles.
3. Run all checks and inspect generated changelogs/version diffs.
4. Commit with `chore(release): version packages` and review the release PR.
5. Merge to main. Once **Checks** passes for that push, **Build release** automatically builds the exact checked commit and publishes `vX.Y.Z` using `extension/package.json`'s Changesets-managed version. The release includes the extension ZIP, four relay bundles, build metadata and checksums. Matching extension/server versions are required. Already published versions and delayed older versions are skipped; drafts and orphan tags fail rather than replacing assets. Apply and merge a reviewed Changesets version bump for the next release.
6. After the GitHub release succeeds, the reusable **Chrome Web Store** workflow verifies and submits the same tagged ZIP. Google publishes it automatically after approval. Listing and API v2 credentials must be configured. Store failure leaves the GitHub release available and fails the release workflow; retry **Chrome Web Store** manually with the same tag and `submit-review`/`DEFAULT_PUBLISH`. Manual `dry-run`, `upload-draft` and staged submission remain available. Private packages are never published to npm.

Manual **Build release** remains available on main and reruns checks before building. Automatic runs accept only successful main push checks from this repository, including merged PRs; PR checks and failed/cancelled checks cannot release.

Changesets are the source for unreleased notes. Do not manufacture a released version/changelog until there is an intentional release. Deployment and protocol recovery steps belong in the relevant release notes.

`pnpm exec vp run release:prepare` validates and creates inspectable artifacts in ignored `release/`. It does not bump versions, commit, tag or publish. Vite+ built-in checks/tests and WXT task commands are distinguished in the README.

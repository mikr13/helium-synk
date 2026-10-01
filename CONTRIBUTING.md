# Contributing

## Commits and changesets

Use Conventional Commits for each coherent completed step, for example `feat(core): persist encrypted outgoing records`, `fix(server): reject conflicting retries`, or `docs: record compatibility evidence`. Use `!` plus a `BREAKING CHANGE:` footer for breaking behavior.

Install the repository-local commit hook with `pnpm hooks:install`. CI also validates commit messages on pull requests. Keep runtime changes, tests, and their changeset together.

Run `pnpm changeset` for user-visible changes. Select the affected private packages; write concise behavior-oriented notes with material limitations. Documentation/tooling-only changes do not need a release bump. Before 1.0, choose a minor bump for incompatible public/protocol changes and explicitly describe compatibility. Patch bumps cover compatible fixes.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm prepare
pnpm check
pnpm check:server
pnpm check:versions
pnpm test:integration
pnpm format:check
```

Do browser compatibility tests in disposable profiles. Never point test adapters at the user's normal bookmarks/history. Mark plan gates complete only with recorded evidence.

## Release procedure

1. Review pending `.changeset/*.md` entries with `pnpm changeset status`.
2. On a release branch, run `pnpm version-packages`. It generates per-package CHANGELOG.md files, updates package versions, synchronizes the Rust crate version, and refreshes lockfiles.
3. Run all checks and inspect generated changelogs/version diffs.
4. Commit with `chore(release): version packages` and review the release PR.
5. Tag/build a GitHub release only after that change is merged. This repository has no automatic publishing job; private packages are never published to npm.

Changesets are the source for unreleased notes. Do not manufacture a released version/changelog until there is an intentional release. Deployment and protocol recovery steps belong in the relevant release notes.

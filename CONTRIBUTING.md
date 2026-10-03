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
5. On main, run **Build release** in GitHub Actions. It reruns checks and creates a draft `vX.Y.Z` release with extension ZIP, four relay bundles and checksums. An existing tag fails rather than replacing a release.
6. Review the draft's assets/notes, then publish it deliberately. Use **Chrome Web Store** separately after its listing and API v2 credentials are configured. Start with `dry-run`; staged review still needs a final Publish in the store. Private packages are never published to npm.

Changesets are the source for unreleased notes. Do not manufacture a released version/changelog until there is an intentional release. Deployment and protocol recovery steps belong in the relevant release notes.

`pnpm exec vp run release:prepare` validates and creates inspectable artifacts in ignored `release/`. It does not bump versions, commit, tag or publish. Vite+ built-in checks/tests and WXT task commands are distinguished in the README.

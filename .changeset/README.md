# Release notes

Run `pnpm changeset` for each user-visible feature/fix and describe behavior, affected packages, and limitations. Use Conventional Commits independently; release notes should read well without commit-message context.

All workspace packages are private applications/internal code. Changesets versions them and generates per-package changelogs, but we do not publish to npm. The Rust server has a private package manifest only to participate in this workflow. `pnpm version-packages` synchronizes its version into Cargo.toml and refreshes both lockfiles.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the release procedure. Add changesets during development; consume them only for an intentional release. Do not edit generated release entries by hand.

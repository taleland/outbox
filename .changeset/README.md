# Changesets

Run `pnpm changeset` for changes that need a package release. All four packages belong to a fixed version group.

Prepare versions and changelogs in a separate PR with `pnpm version-packages`, then update the workspace lockfile with `pnpm install --lockfile-only`. Use a Conventional Commit title such as `chore: version outbox packages`.

Merging a version PR triggers npm publishing when `NPM_PUBLISH_ENABLED=true`. See the root README for Trusted Publisher setup and release prerequisites.

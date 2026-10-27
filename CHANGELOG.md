# Changelog

This monorepo maintains release notes for each package:

- [@taleland/outbox-core](packages/core/CHANGELOG.md)
- [@taleland/outbox-mikro-orm](packages/mikro-orm/CHANGELOG.md)
- [@taleland/outbox-nestjs](packages/nestjs/CHANGELOG.md)
- [@taleland/outbox-nodets-bus](packages/nodets-bus/CHANGELOG.md)

Changesets generates these changelogs when preparing version PRs. After npm publication succeeds, the release workflow pushes package tags and creates a [GitHub Release](https://github.com/taleland/outbox/releases) for each package version using its changelog entry. Retrying publication also fills in missing releases without republishing existing package versions.

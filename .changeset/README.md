# Changesets

Every published package is versioned together (`fixed` in `config.json`),
because they are built and tested as one system and a provider should never
have to work out which runtime goes with which CLI.

Add a changeset with `pnpm changeset` in any pull request that changes what a
published package does. CHANGELOG files are generated from these, and are
never edited by hand.

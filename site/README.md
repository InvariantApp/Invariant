# The site

`docs/` and `proving/SCOREBOARD.md`, rendered. Nothing here is written twice:
`scripts/sync-docs.mts` copies the documentation in, gives each page the front
matter the renderer needs from its own first heading, and turns a link to
another `.md` file into a link to that page. The evidence page is the
scoreboard the proving ground generates, one section per line of the launch
gate.

```console
npm install
npm run dev      # sync and serve
npm run build    # sync and build into dist/
```

It has its own dependencies and its own lockfile, deliberately: it is not part
of the pnpm workspace, so nothing it needs can reach a package a provider
installs.

The front page is `src/pages/index.astro`. Every number on it comes from the
evidence page rather than from marketing.

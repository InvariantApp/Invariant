// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

/**
 * The documentation site: the repository's own `docs/` rendered, plus the
 * evidence page the proving ground generates. Static, no analytics, no
 * tracking, and nothing that needs a server.
 */
export default defineConfig({
  site: "https://invariant.build",
  integrations: [
    starlight({
      title: "Invariant",
      tagline: "Change your API without breaking anyone.",
      description:
        "Invariant reads what your API release changes, blocks what it cannot serve, " +
        "keeps old callers working, and sends your customers the edit.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/InvariantApp/Invariant",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/InvariantApp/Invariant/edit/main/docs/",
      },
      customCss: ["./src/styles.css"],
      sidebar: [
        { label: "Quickstart", link: "/quickstart" },
        {
          label: "Put the runtime in your service",
          items: [
            { label: "Express", link: "/adapters/express" },
            { label: "Fastify", link: "/adapters/fastify" },
            { label: "Hono", link: "/adapters/hono" },
            { label: "Koa", link: "/adapters/koa" },
            { label: "NestJS", link: "/adapters/nestjs" },
            { label: "Next.js", link: "/adapters/nextjs" },
            { label: "node:http", link: "/adapters/node-http" },
            { label: "Go net/http", link: "/adapters/go" },
            { label: "The proxy, for any language", link: "/adapters/proxy" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "The command line", link: "/reference/cli" },
            { label: "invariant.yaml", link: "/reference/configuration" },
            { label: "Breaking changes", link: "/reference/breaking-changes" },
            { label: "Errors", link: "/reference/errors" },
          ],
        },
        {
          label: "Deeper",
          items: [
            { label: "Moving your consumers", link: "/migrations" },
            { label: "The change format", link: "/ir-spec" },
            { label: "What a release bundle is", link: "/evolution-bundle-v1" },
          ],
        },
        {
          label: "About",
          items: [
            { label: "Evidence", link: "/evidence" },
            { label: "Security", link: "/security" },
          ],
        },
      ],
    }),
  ],
});

/**
 * Every name this product is published under, in one place.
 *
 * When one changes, this is the file that changes, and brand.test.ts fails
 * on any copy of the addresses written anywhere else in the code.
 */
export const BRAND = {
  /** What the product is called in prose. */
  name: "Invariant",
  /** The command a provider types. */
  command: "invariant",
  /** The npm scope every published package lives under. */
  scope: "@invariant-app",
  /** The public repository, which also hosts the GitHub Action. */
  repository: "InvariantApp/Invariant",
  /** Where the documentation lives. */
  docs: "https://github.com/InvariantApp/Invariant/blob/main/docs",
  /** The hosted service a command or runtime talks to unless told otherwise. */
  service: "https://invariant-cloud.fly.dev",
  /**
   * The in-toto predicate type a signed bundle carries: the page that says
   * what the predicate means, at an address this project controls. Embedded
   * in every bundle ever signed, so it never changes.
   */
  predicateType:
    "https://github.com/InvariantApp/Invariant/blob/main/docs/evolution-bundle-v1.md",
} as const;

/** The GitHub Action a provider's workflow uses, at the given major version. */
export function actionRef(major = "v0"): string {
  return `${BRAND.repository}@${major}`;
}

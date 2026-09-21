/**
 * Every name this product is published under, in one place.
 *
 * The product name, the npm scope and the domain are not settled: "Invariant"
 * is also the name of an AI security company, and the scope and domain have
 * to be owned before anything is published under them. When they change, this
 * is the file that changes, and a test fails on any copy of them written
 * anywhere else.
 */
export const BRAND = {
  /** What the product is called in prose. */
  name: "Invariant",
  /** The command a provider types. */
  command: "invariant",
  /** The npm scope every published package lives under. */
  scope: "@invariant",
  /** The public repository, which also hosts the GitHub Action. */
  repository: "InvariantApp/Invariant",
  /** Where the documentation lives. */
  docs: "https://github.com/InvariantApp/Invariant/blob/main/docs",
  /**
   * The in-toto predicate type a signed bundle carries. Embedded in every
   * bundle ever signed, so it must be a URL this project controls before the
   * first bundle is published.
   */
  predicateType: "https://invariant.dev/evolution-bundle/v1",
} as const;

/** The GitHub Action a provider's workflow uses, at the given major version. */
export function actionRef(major = "v0"): string {
  return `${BRAND.repository}@${major}`;
}

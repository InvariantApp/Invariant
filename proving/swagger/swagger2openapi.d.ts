/** The part of `swagger2openapi` the oracle uses. It ships no types of its own. */
declare module "swagger2openapi" {
  interface Options {
    patch?: boolean;
    warnOnly?: boolean;
    resolveInternal?: boolean;
  }
  const swagger2openapi: {
    convertObj(document: unknown, options: Options): Promise<{ openapi: unknown }>;
  };
  export default swagger2openapi;
}

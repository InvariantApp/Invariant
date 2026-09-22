// The shape stripe-node declares: options in a namespace inside an ambient
// module, the API version typed as the one version the release was built for.
declare module "paysdk" {
  namespace Pay {
    type LatestApiVersion = "2023-10-16";
    interface PayConfig {
      apiVersion?: LatestApiVersion;
      timeout?: number;
    }
  }
  class Pay {
    constructor(key: string, config?: Pay.PayConfig);
  }
  export = Pay;
}

// The shape stripe-node declares: options in a namespace inside an ambient
// module, the API version typed as the one version the release was built for.
declare module "paysdk" {
  namespace Pay {
    type LatestApiVersion = "2023-10-16";
    interface PayConfig {
      apiVersion?: LatestApiVersion;
      timeout?: number;
    }
    interface Subscription {
      id: string;
      /** Gone in the next contract, with nothing declared in its place. */
      discount: { coupon: string } | null;
      automatic_tax: Subscription.AutomaticTax;
      items: Array<{ id: string; current_period_end: number }>;
    }
    namespace Subscription {
      interface AutomaticTax {
        enabled: boolean;
      }
    }
  }
  namespace Pay {
    class InvoicesResource {
      /** GET /v1/invoices/upcoming, retired in the next contract. */
      retrieveUpcoming(params: { customer: string }): Promise<{ id: string }>;
      retrieve(id: string): Promise<{ id: string }>;
    }
  }
  class Pay {
    constructor(key: string, config?: Pay.PayConfig);
    subscriptions: { retrieve(id: string): Promise<Pay.Subscription> };
    invoices: Pay.InvoicesResource;
  }
  export = Pay;
}

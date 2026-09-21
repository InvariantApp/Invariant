/** An old contract whose list responses are adapted item by item. */
export const OLD = "2026-01-01";
export const CURRENT = "2026-09-20";
export const HEADER = "payments-version";

export const PROGRAM = {
  irVersion: 2,
  api: "payments",
  current: "sha256:head",
  currentLabel: CURRENT,
  identity: [
    { kind: "header", name: HEADER },
    { kind: "default", label: CURRENT },
  ],
  contracts: {
    [OLD]: {
      label: OLD,
      routes: [],
      sites: {
        "get /v1/payments": {
          response: {
            "2xx": [
              {
                k: "within",
                path: "/data/*",
                block: [
                  { k: "move", from: "/amount_cents", to: "/amount", c: "chg_amount" },
                  {
                    k: "enum",
                    path: "/status",
                    map: { succeeded: "paid" },
                    c: "chg_status",
                  },
                ],
                c: "chg_amount",
              },
            ],
          },
        },
      },
      behaviors: [],
      retired: [],
    },
  },
};

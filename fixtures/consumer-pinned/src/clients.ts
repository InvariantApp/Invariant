import Pay from 'paysdk';

export const direct = new Pay("sk_test", { apiVersion: '2023-10-16', timeout: 10 });

const API_VERSION = "2023-10-16";
export const throughConstant = new Pay("sk_test", { apiVersion: API_VERSION });

export const asserted = new Pay("sk_test", {
  apiVersion: "2023-10-16" as Pay.LatestApiVersion,
});

export const fromEnvironment = new Pay("sk_test", {
  apiVersion: process.env["PAY_API_VERSION"] as Pay.LatestApiVersion,
});

// Not the SDK's option, though it has the same name.
export const unrelated = { apiVersion: "2023-10-16" };

// The pin in the consumer's own configuration, passed on by property.
const config = { pay: { apiVersion: "2023-10-16" as const, timeout: 5 } };
export const fromConfiguration = new Pay("sk_test", { apiVersion: config.pay.apiVersion });

// Destructured from the configuration and passed as a shorthand property.
const { apiVersion } = config.pay;
export const fromDestructuring = new Pay("sk_test", { apiVersion });

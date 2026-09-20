import { createAcmeApp } from "@fixtures/provider-acme";
import type { AcmeConfig } from "./donations.ts";

export const CONSUMER_C_KEY = "sk_test_charlie";

export function connectAcme(): AcmeConfig {
  const external = process.env["ACME_BASE_URL"];
  if (external) {
    return {
      apiKey: process.env["ACME_API_KEY"] ?? CONSUMER_C_KEY,
      baseUrl: external,
    };
  }

  const { fetch: acme } = createAcmeApp({ build: "2026-03-01" });
  return {
    apiKey: CONSUMER_C_KEY,
    baseUrl: "http://acme.test",
    fetch: async (input, init) => acme(new Request(input as string | URL, init)),
  };
}

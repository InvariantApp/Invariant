import { createAcmeApp } from "@fixtures/provider-acme";
import { type AcmeClient, createAcmeClient } from "./checkout.ts";

export const CONSUMER_B_KEY = "sk_test_bravo";

export function connectAcme(): AcmeClient {
  const external = process.env["ACME_BASE_URL"];
  if (external) {
    return createAcmeClient({
      apiKey: process.env["ACME_API_KEY"] ?? CONSUMER_B_KEY,
      baseUrl: external,
    });
  }

  const { app } = createAcmeApp({ build: "2026-03-01" });
  return createAcmeClient({
    apiKey: CONSUMER_B_KEY,
    baseUrl: "http://acme.test",
    fetch: async (input, init) => app.fetch(new Request(input as string | URL, init)),
  });
}

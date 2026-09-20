/**
 * Test support. Consumer A talks to whatever Acme deployment the environment
 * points at: an in-process build of the provider it was written against by
 * default, or a real base URL when the end-to-end demo supplies one.
 */
import { createAcmeApp } from "@fixtures/provider-acme";

export interface AcmeConnection {
  apiKey: string;
  baseUrl: string;
  fetch: typeof globalThis.fetch;
}

export const CONSUMER_A_KEY = "sk_test_alpha";

export function connectAcme(): AcmeConnection {
  const external = process.env["ACME_BASE_URL"];
  if (external) {
    return {
      apiKey: process.env["ACME_API_KEY"] ?? CONSUMER_A_KEY,
      baseUrl: external,
      fetch: globalThis.fetch,
    };
  }

  const { app } = createAcmeApp({ build: "2026-01-15" });
  return {
    apiKey: CONSUMER_A_KEY,
    baseUrl: "http://acme.test",
    fetch: async (input, init) => app.fetch(new Request(input as string | URL, init)),
  };
}

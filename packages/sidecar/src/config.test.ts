/**
 * The configuration refuses anything it does not understand, because a setting
 * that is quietly ignored surfaces as the wrong contract served to real traffic.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig, skipper } from "./config.ts";

const base = {
  program: "program.json",
  upstream: "http://127.0.0.1:8000",
  identity: [
    { kind: "header", name: "Api-Version" },
    { kind: "default", label: "2026-01-01" },
  ],
};

describe("reading the configuration", () => {
  it("fills in safe defaults and resolves the program beside the file", () => {
    const config = parseConfig(base, "/etc/invariant");
    expect(config.program).toBe("/etc/invariant/program.json");
    expect(config.listen).toEqual({ port: 8080, host: "127.0.0.1" });
    expect(config.maxBodyBytes).toBe(1024 * 1024);
    // Header names are compared case-insensitively on the wire.
    expect(config.identity?.[0]).toEqual({ kind: "header", name: "api-version" });
  });

  it("reads TLS files beside the configuration, and refuses a mistyped listen key", () => {
    const config = parseConfig(
      {
        ...base,
        listen: { port: 8443, tls: { certFile: "tls/cert.pem", keyFile: "tls/key.pem" } },
      },
      "/etc/invariant",
    );
    expect(config.listen.tls).toEqual({
      certFile: "/etc/invariant/tls/cert.pem",
      keyFile: "/etc/invariant/tls/key.pem",
    });
    expect(() => parseConfig({ ...base, listen: { tsl: {} } }, "/")).toThrow(
      /Unknown setting "listen.tsl"/,
    );
    expect(() =>
      parseConfig({ ...base, listen: { tls: { certFile: "c.pem" } } }, "/"),
    ).toThrow(/listen.tls\."keyFile" is required/);
  });

  it("refuses a setting it does not know, rather than ignoring a typo", () => {
    expect(() => parseConfig({ ...base, upstrem: "x" }, "/")).toThrow(
      /Unknown setting "upstrem"/,
    );
  });

  it("refuses the principal strategy, which the sidecar cannot honour", () => {
    expect(() =>
      parseConfig({ ...base, identity: [{ kind: "principal" }] }, "/"),
    ).toThrow(/not available to the sidecar/);
  });

  it("refuses an upstream that is not http", () => {
    expect(() => parseConfig({ ...base, upstream: "file:///etc/passwd" }, "/")).toThrow(
      ConfigError,
    );
  });

  it("refuses an identity list with nothing in it", () => {
    expect(() => parseConfig({ ...base, identity: [] }, "/")).toThrow(
      /at least one strategy/,
    );
  });
});

describe("the skip list", () => {
  it("matches exact paths and prefixes", () => {
    const skip = skipper(["/healthz", "/internal/*"]);
    expect(skip("/healthz")).toBe(true);
    expect(skip("/healthz/deep")).toBe(false);
    expect(skip("/internal/metrics")).toBe(true);
    expect(skip("/v1/payments")).toBe(false);
  });
});

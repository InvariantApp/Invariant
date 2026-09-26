import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  limitsFor,
  mountsFor,
  OutputTail,
  outcomeOf,
  phaseEnvironment,
  SandboxError,
  WORKSPACE,
  withCpuLimit,
} from "./sandbox.ts";

describe("the two phases", () => {
  it("never shows the fetch the repository, and gives the analysis one writable directory", () => {
    expect(mountsFor("fetch")).toEqual([
      { part: "request", target: WORKSPACE.request, readOnly: true },
      { part: "packages", target: WORKSPACE.packages, readOnly: false },
    ]);
    const analyse = mountsFor("analyse");
    expect(analyse.filter((mount) => !mount.readOnly).map((mount) => mount.part)).toEqual(
      ["out"],
    );
    expect(analyse.map((mount) => mount.part).sort()).toEqual([
      "out",
      "packages",
      "repo",
      "request",
    ]);
  });

  it("sends every client in the fetch through the proxy, with install scripts off", () => {
    const env = phaseEnvironment("fetch", {
      proxy: "http://egress-proxy:3128",
      // What a caller cannot undo.
      env: {
        npm_config_ignore_scripts: "false",
        HTTPS_PROXY: "http://elsewhere",
        EXTRA: "1",
      },
    });
    expect(env).toMatchObject({
      HTTPS_PROXY: "http://egress-proxy:3128",
      https_proxy: "http://egress-proxy:3128",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "",
      npm_config_ignore_scripts: "true",
      npm_config_https_proxy: "http://egress-proxy:3128",
      PIP_ONLY_BINARY: ":all:",
      GOTOOLCHAIN: "local",
      GOVCS: "*:off",
      GOPROXY: "https://proxy.golang.org",
      EXTRA: "1",
    });
    expect(() => phaseEnvironment("fetch")).toThrow(SandboxError);
  });

  it("gives the analysis no proxy, and a module proxy that is off", () => {
    const env = phaseEnvironment("analyse", { env: { HTTPS_PROXY: "http://elsewhere" } });
    expect(env["GOPROXY"]).toBe("off");
    expect(env["npm_config_offline"]).toBe("true");
    expect(
      Object.keys(env).filter((key) => /proxy/i.test(key) && !key.startsWith("GO")),
    ).toEqual([]);
  });

  it("checks the limits a caller sets", () => {
    expect(limitsFor("analyse", { memoryMb: 512 })).toEqual({
      ...DEFAULT_LIMITS.analyse,
      memoryMb: 512,
    });
    expect(() => limitsFor("fetch", { wallSeconds: 0 })).toThrow(/wallSeconds/);
    expect(() => limitsFor("fetch", { cpus: Number.NaN })).toThrow(/cpus/);
  });

  it("reads a finished phase's status the same way for every driver", () => {
    expect(outcomeOf({ exitCode: 0 })).toBe("ok");
    expect(outcomeOf({ exitCode: 1 })).toBe("exit");
    expect(outcomeOf({ exitCode: 137, oomKilled: true })).toBe("memory");
    expect(outcomeOf({ exitCode: 152 })).toBe("cpu");
    expect(outcomeOf({ exitCode: null, signal: "SIGXCPU" })).toBe("cpu");
    expect(outcomeOf({ exitCode: 137, timedOut: true })).toBe("timeout");
    expect(
      outcomeOf({
        exitCode: 134,
        output:
          "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
      }),
    ).toBe("memory");
  });

  it("caps CPU time without a shell reading the command", () => {
    expect(withCpuLimit(["node", "a b; rm -rf /"], 30)).toEqual([
      "/bin/sh",
      "-c",
      'ulimit -t "$0" && exec "$@"',
      "30",
      "node",
      "a b; rm -rf /",
    ]);
  });

  it("keeps the end of what a phase prints", () => {
    const tail = new OutputTail(10);
    for (let index = 0; index < 100; index += 1) tail.push(String(index % 10));
    expect(tail.toString()).toBe("0123456789");
  });
});

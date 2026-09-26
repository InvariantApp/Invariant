# @invariant-app/sandbox

## 0.5.0

### Minor Changes

- 8f3e365: A migration can now run in a sandbox, in two phases.
  
  `@invariant-app/sandbox` is new. Its `Sandbox` interface runs a fetch phase, which downloads the SDK releases a migration reads with install scripts off and can reach only the package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `proxy.golang.org`, `sum.golang.org`, and any host a caller adds) through an egress proxy, and an analyse phase, which reads the repository with no network at all, read-only inputs and one writable output directory. Each phase runs under limits on memory, CPUs, CPU time and the wall clock, and a failure says which: `timeout`, `memory`, `cpu`, `exit`, `driver` or `unavailable`. The egress proxy is an HTTP CONNECT proxy that opens tunnels only to allowlisted host names, on 443 by default, never to a name that resolves to a private, loopback or link-local address, and never for plain HTTP; it also runs on its own as `invariant-egress-proxy`. Three drivers: `oci-rootless` runs each phase in a docker or podman container as a non-root user with a read-only root filesystem, no capabilities and `--network=none` for the analysis, and the fetch on an internal network whose only way out is the proxy; `k8s-job` runs each phase as a Job under a gVisor or Kata RuntimeClass with a NetworkPolicy that denies an analysis all traffic and a fetch everything but the proxy; `fly-machine` runs each phase in a one-shot Fly Machine that is destroyed when it exits and never restarted.
  
  `invariant migrate <job.json>` is new: it moves one consumer repository to a release with the same engine the hosted service runs, for TypeScript, Python and Go. By default it runs in this process; `--sandbox oci-rootless` runs each phase in a container, with this same installation of the CLI mounted read-only. The language packs are optional peer dependencies of the CLI, loaded only when a job needs one.
  
  The go command the Go pack runs now keeps `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` from the environment, so it reaches the module proxy from behind a proxy, as a sandboxed fetch does; nothing else of the caller's environment is kept.
  
  A TypeScript consumer migrated through its tsconfig now gets edits when its SDK is installed the usual way, as declarations under node_modules: the engine now reads the SDK's declarations it is given even where the project resolves them without listing them.

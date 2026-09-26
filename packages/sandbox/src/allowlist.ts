/**
 * Which hosts a fetch may reach.
 *
 * Exactly the registries the language packs download from, by name, and
 * nothing that merely looks like one: `registry.npmjs.org.example.com` and
 * `evil.registry.npmjs.org` are different hosts, and neither is on the list.
 * A caller adds a private registry by its exact name.
 */

/**
 * - npm: `registry.npmjs.org` serves both the metadata and the tarballs.
 * - PyPI: `pypi.org` answers the JSON API; the wheels are on
 *   `files.pythonhosted.org`.
 * - Go: `proxy.golang.org` serves modules, and `sum.golang.org` is the
 *   checksum database each download is verified against.
 */
export const REGISTRIES: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
];

/** A host name as DNS compares it: lower case, without a trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Whether `host` is a DNS name at all, rather than an address or something
 * a URL parser would read differently from a resolver.
 */
export function isHostName(host: string): boolean {
  const name = normalizeHost(host);
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  // The last label of a name is never a number, which rules out every way
  // of writing an IPv4 address that a resolver accepts: dotted, short
  // (`127.1`), and hexadecimal (`0x7f000001`).
  if (/^([0-9]+|0x[0-9a-f]*)$/.test(labels.at(-1) ?? "")) return false;
  return labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

/** The allowlist a fetch runs with: the registries and any extras, checked. */
export function allowlist(extra: readonly string[] = []): Set<string> {
  const hosts = new Set(REGISTRIES);
  for (const host of extra) {
    if (!isHostName(host)) {
      throw new Error(`"${host}" is not a host name the fetch could be allowed to reach`);
    }
    hosts.add(normalizeHost(host));
  }
  return hosts;
}

export function allowed(host: string, hosts: ReadonlySet<string>): boolean {
  return isHostName(host) && hosts.has(normalizeHost(host));
}

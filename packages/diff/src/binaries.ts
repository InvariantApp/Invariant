/**
 * The oasdiff binaries shipped with the published packages.
 *
 * The gate shells out to oasdiff, which is a Go program, and a provider should
 * not need a Go toolchain to run a check in their CI. Each platform gets its
 * own package holding the upstream release binary, installed only on the
 * platform it is for, the way esbuild ships its own.
 *
 * Nothing here is built by this project. The binaries are upstream's release
 * assets, and each one is checked against two hashes before it is packed:
 * upstream's published checksums.txt, and the hash recorded below, which is
 * committed. A replaced asset upstream would have to match a hash written down
 * here before anyone downloaded it.
 */
import { OASDIFF_VERSION } from "./version.ts";

export interface PlatformBinary {
  /** The npm package that carries it. */
  package: string;
  /** `${process.platform}-${process.arch}` values it serves. */
  targets: string[];
  os: string[];
  cpu: string[];
  /** The upstream release asset. */
  asset: string;
  sha256: string;
  /** The executable's name inside the asset and the package. */
  executable: string;
}

const bare = OASDIFF_VERSION.replace(/^v/, "");

export const PLATFORM_BINARIES: readonly PlatformBinary[] = [
  {
    package: "@invariant-app/oasdiff-linux-x64",
    targets: ["linux-x64"],
    os: ["linux"],
    cpu: ["x64"],
    asset: `oasdiff_${bare}_linux_amd64.tar.gz`,
    sha256: "6b8af23ed2c60e07dcf58d1969d064d586022d0cda068fb451217af0ecb0e7e4",
    executable: "oasdiff",
  },
  {
    package: "@invariant-app/oasdiff-linux-arm64",
    targets: ["linux-arm64"],
    os: ["linux"],
    cpu: ["arm64"],
    asset: `oasdiff_${bare}_linux_arm64.tar.gz`,
    sha256: "1a96be5b14a21ac5659018103f9237b60086508d35f2dd7210be74f868a24e00",
    executable: "oasdiff",
  },
  {
    // Upstream publishes one universal binary for both Mac architectures.
    package: "@invariant-app/oasdiff-darwin",
    targets: ["darwin-x64", "darwin-arm64"],
    os: ["darwin"],
    cpu: ["x64", "arm64"],
    asset: `oasdiff_${bare}_darwin_all.tar.gz`,
    sha256: "734352e8b91029defa7aa64ef76c449defaa8121313e955a8fb44418acdb3e2b",
    executable: "oasdiff",
  },
  {
    package: "@invariant-app/oasdiff-win32-x64",
    targets: ["win32-x64"],
    os: ["win32"],
    cpu: ["x64"],
    asset: `oasdiff_${bare}_windows_amd64.tar.gz`,
    sha256: "ba8725f245a25c96d2fd0e31b6a02e96d1a6be0d9e9e156dc0996fd5645a76f1",
    executable: "oasdiff.exe",
  },
  {
    package: "@invariant-app/oasdiff-win32-arm64",
    targets: ["win32-arm64"],
    os: ["win32"],
    cpu: ["arm64"],
    asset: `oasdiff_${bare}_windows_arm64.tar.gz`,
    sha256: "b1624f202e9a68a07b63bf31e1935fad0b8ac2053c887a2c1db9474a8ff9e411",
    executable: "oasdiff.exe",
  },
];

/** The binary for this machine, if one is published for it. */
export function binaryFor(
  platform: string = process.platform,
  arch: string = process.arch,
): PlatformBinary | undefined {
  return PLATFORM_BINARIES.find((binary) =>
    binary.targets.includes(`${platform}-${arch}`),
  );
}

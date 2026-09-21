/**
 * Puts the licence and notice beside a package as it is packed.
 *
 * npm only ever ships a LICENSE from the package's own directory. Keeping
 * fourteen copies in the repository would be fourteen chances for one to
 * differ from the others, so they are copied from the root at pack time and
 * ignored by git.
 */
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath rather than URL.pathname, which on Windows yields "/D:/..." and
// then "D:\D:\..." once joined.
const root = fileURLToPath(new URL("..", import.meta.url));
for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(join(root, name), join(process.cwd(), name));
}

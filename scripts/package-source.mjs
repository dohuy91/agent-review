import { execFileSync } from "node:child_process";
import { open, rm, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  console.error(
    "Usage: pnpm package:source <new-output.tar.gz outside repository>",
  );
  process.exit(1);
}
let reserved = false;
try {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const target = resolve(
    await realpath(dirname(resolve(output))),
    requireName(output),
  );
  const rel = relative(root, target);
  if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("Choose an output outside the repository");
  const file = await open(target, "wx", 0o600);
  reserved = true;
  try {
    execFileSync("git", ["archive", "--format=tar.gz", "HEAD"], {
      stdio: ["ignore", file.fd, "pipe"],
    });
  } finally {
    await file.close();
  }
  console.log(`Packaged tracked HEAD sources: ${target}`);
} catch (error) {
  if (reserved) await rm(resolve(output), { force: true });
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
function requireName(path) {
  return path.split("/").at(-1);
}

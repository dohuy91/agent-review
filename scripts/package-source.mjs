import { execFileSync } from "node:child_process";
import { open, rm, realpath } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
const excludedDirectories = new Set([
  ".git",
  ".superpowers",
  ".agents",
  ".codex",
  ".aws",
  "node_modules",
  ".pnpm-store",
  ".pnpm-config",
  "dist",
]);
function portableSource(path) {
  const parts = path.split("/");
  const name = parts.at(-1);
  return (
    !parts.some((part) => excludedDirectories.has(part)) &&
    !path.startsWith("docs/superpowers/") &&
    name !== ".env" &&
    !name.startsWith(".env.") &&
    !/\.(?:sqlite.*|db(?:[-.].*)?|pem|key|log|tar\.gz)$/i.test(name)
  );
}
const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  console.error(
    "Usage: pnpm package:source <new-output.tar.gz outside repository>",
  );
  process.exit(1);
}
let reserved = false;
let target;
try {
  const root = await realpath(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim(),
  );
  target = resolve(
    await realpath(dirname(resolve(output))),
    requireName(output),
  );
  const rel = relative(root, target);
  if (!rel || (!rel.startsWith("../") && !isAbsolute(rel)))
    throw new Error("Choose an output outside the repository");
  const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const files = execFileSync("git", ["ls-tree", "-rz", "--full-tree", commit], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const separator = entry.indexOf("\t");
      const metadata = entry.slice(0, separator).split(" ");
      const path = entry.slice(separator + 1);
      if (!portableSource(path)) return [];
      if (
        separator < 0 ||
        !["100644", "100755"].includes(metadata[0]) ||
        metadata[1] !== "blob" ||
        path.includes("\ufffd")
      )
        throw new Error("Source bundle requires regular UTF-8 tracked paths");
      return [path];
    });
  if (!files.length) throw new Error("No portable tracked sources found");
  if (Buffer.byteLength(files.join("\0")) > 256 * 1024)
    throw new Error("Source path list is too large for portable packaging");
  const file = await open(target, "wx", 0o600);
  reserved = true;
  try {
    execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "archive",
        "--format=tar.gz",
        commit,
        "--",
        ...files,
      ],
      {
        cwd: root,
        stdio: ["ignore", file.fd, "pipe"],
      },
    );
  } finally {
    await file.close();
  }
  console.log(`Packaged portable tracked HEAD sources: ${target}`);
} catch (error) {
  if (reserved) await rm(target, { force: true });
  console.error(`Packaging failed: ${error.message}`);
  process.exitCode = 1;
}
function requireName(path) {
  return path.split("/").at(-1);
}

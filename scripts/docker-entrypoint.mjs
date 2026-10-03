import { realpath, readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";
process.umask(0o077);
try {
  const root = await realpath(process.argv[2] ?? "");
  // Only the explicit launch root receives ownership trust; no wildcard config.
  execFileSync("git", ["config", "--global", "--add", "safe.directory", root]);
  let metadata;
  try {
    metadata = await readFile(join(root, ".git"), "utf8");
  } catch (e) {
    if (e.code !== "EISDIR") throw e;
  }
  if (metadata?.startsWith("gitdir: ")) {
    const gitDir = resolve(root, metadata.slice(8).trim());
    try {
      await access(gitDir, constants.R_OK);
      const common = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      await access(
        resolve(dirname(join(gitDir, "commondir")), common),
        constants.R_OK,
      );
    } catch {
      throw new Error(
        `Linked worktree metadata is missing: mount ${gitDir} and its common Git directory read-only at their original absolute host paths. Use git rev-parse --absolute-git-dir and git rev-parse --path-format=absolute --git-common-dir on the host.`,
      );
    }
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "apps/server/src/cli.ts",
      root,
      ...process.argv.slice(3),
      "--container",
    ],
    { stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", (error) => {
    console.error(error.message);
    process.exit(1);
  });
} catch (error) {
  console.error(`Unable to launch container: ${error.message}`);
  process.exitCode = 1;
}

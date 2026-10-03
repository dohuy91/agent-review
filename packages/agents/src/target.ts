import { git, safeStat } from "../../git/src/git.js";
import { createHash } from "node:crypto";
import type { Repository } from "../../shared/src/index.js";
// Execution-only: all modes authorize a mutable process, even when their visible diff is immutable.
export async function executionStamp(repository: Repository): Promise<string> {
  const index = await git(repository.root, ["ls-files", "--stage", "-z"]);
  const paths = (
    await git(repository.root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (paths.length > 20000)
    throw new Error("Execution workspace exceeds limit");
  const hash = createHash("sha256").update(index);
  hash.update(await git(repository.root, ["config", "--null", "--list"]));
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path);
    try {
      const s = await safeStat(repository.root, path);
      hash.update(
        JSON.stringify(
          s
            ? [
                String(s.dev),
                String(s.ino),
                String(s.mode),
                String(s.size),
                String(s.mtimeNs),
                String(s.ctimeNs),
              ]
            : null,
        ),
      );
    } catch {
      throw Object.assign(new Error("Execution workspace unverifiable"),{statusCode:409});
    }
  }
  return hash.digest("hex");
}

import { git, safeStat, readIndexBytes } from "../../git/src/git.js";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const rawIndex = await readIndexBytes(repository.gitDir);
  hash.update(rawIndex ?? "missing-index");
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
      throw Object.assign(new Error("Execution workspace unverifiable"), {
        statusCode: 409,
      });
    }
  }
  return hash.digest("hex");
}

/** Directory identity is part of the exact confirmation, in addition to the review execution stamp. */
export async function startingFolderStamp(
  repository: Repository,
  input: string,
  skillRoot = false,
): Promise<string> {
  const { validateStartingFolder } =
    await import("../../review/src/project-settings.js");
  const { lstat } = await import("node:fs/promises");
  const { relative, join, sep } = await import("node:path");
  const folder = await validateStartingFolder(repository, input, skillRoot);
  const hash = createHash("sha256").update(folder);
  const rel = relative(repository.root, folder);
  const paths = [repository.root];
  for (const part of rel ? rel.split(sep) : [])
    paths.push(join(paths.at(-1)!, part));
  const identities: string[] = [];
  for (const path of paths) {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Object.assign(new Error("Starting folder changed"), {
        statusCode: 409,
      });
    const identity = JSON.stringify([
      path,
      String(stat.dev),
      String(stat.ino),
      String(stat.mode),
      String(stat.birthtimeNs),
      String(stat.ctimeNs),
    ]);
    identities.push(identity);
    hash.update(identity);
  }
  await validateStartingFolder(repository, folder, skillRoot);
  for (let i = 0; i < paths.length; i++) {
    const stat = await lstat(paths[i], { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      JSON.stringify([
        paths[i],
        String(stat.dev),
        String(stat.ino),
        String(stat.mode),
        String(stat.birthtimeNs),
        String(stat.ctimeNs),
      ]) !== identities[i]
    )
      throw Object.assign(new Error("Starting folder changed"), {
        statusCode: 409,
      });
  }
  return hash.digest("hex");
}

/** No async work may follow the last review stamp. Recheck cwd identity synchronously. */
export function startingFolderStampSync(
  repository: Repository,
  input: string,
): string {
  const changed = () =>
    Object.assign(new Error("Starting folder changed"), { statusCode: 409 });
  try {
    if (
      !isAbsolute(input) ||
      resolve(input) !== input ||
      input.split(/[\\/]/).some((part) => part === "." || part === "..") ||
      realpathSync(repository.root) !== repository.root ||
      realpathSync(input) !== input
    )
      throw changed();
    const rel = relative(repository.root, input);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw changed();
    const paths = [repository.root];
    for (const part of rel ? rel.split(sep) : [])
      paths.push(join(paths.at(-1)!, part));
    const hash = createHash("sha256").update(input);
    for (const path of paths) {
      const stat = lstatSync(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        realpathSync(path) !== path
      )
        throw changed();
      hash.update(
        JSON.stringify([
          path,
          String(stat.dev),
          String(stat.ino),
          String(stat.mode),
          String(stat.birthtimeNs),
          String(stat.ctimeNs),
        ]),
      );
    }
    return hash.digest("hex");
  } catch {
    throw changed();
  }
}

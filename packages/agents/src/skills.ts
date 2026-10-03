import { opendir, realpath, lstat, open } from "node:fs/promises";
import { join, relative, isAbsolute, dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { SkillMetadata, SkillProfile } from "../../shared/src/index.js";
const LIMIT = 256 * 1024;
const contained = (root: string, path: string) => {
  const r = relative(root, path);
  return r !== "" && !r.startsWith("../") && r !== ".." && !isAbsolute(r);
};
const changed = () =>
  Object.assign(new Error("Skill unavailable or changed"), { statusCode: 409 });
async function readSkill(root: string, path: string): Promise<Buffer> {
  const parent = dirname(path);
  if (
    !contained(root, path) ||
    (await realpath(root)) !== root ||
    (await realpath(parent)) !== parent
  )
    throw changed();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(LIMIT)) throw changed();
    // Never allocate or read beyond the fixed byte budget, even if the file grows after stat.
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > LIMIT) throw changed();
    const after = await handle.stat({ bigint: true }),
      current = await lstat(path, { bigint: true });
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      current.size !== after.size ||
      current.mtimeNs !== after.mtimeNs ||
      current.ctimeNs !== after.ctimeNs ||
      (await realpath(parent)) !== parent ||
      (await realpath(root)) !== root
    )
      throw changed();
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export class SkillCatalog {
  constructor(private roots: string[]) {}
  async scan(): Promise<(SkillMetadata & { path: string; root: string })[]> {
    const result: (SkillMetadata & { path: string; root: string })[] = [];
    let visited = 0;
    for (const input of this.roots.slice(0, 16)) {
      let root: string;
      try {
        root = await realpath(input);
        if (root !== resolve(input)) continue;
      } catch {
        continue;
      }
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 5 || visited++ >= 2048 || result.length >= 256) return;
        try {
          if (
            (await realpath(dir)) !== dir ||
            (dir !== root && !contained(root, dir))
          )
            return;
          const entries = await opendir(dir);
          for await (const entry of entries) {
            if (visited++ >= 2048 || result.length >= 256) return;
            if ((await realpath(dir)) !== dir) return;
            const path = join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) await walk(path, depth + 1);
            else if (entry.isFile() && entry.name === "SKILL.md") {
              try {
                const bytes = await readSkill(root, path);
                result.push({
                  locator: path,
                  path,
                  root,
                  name: relative(root, dir) || "root",
                  digest: createHash("sha256").update(bytes).digest("hex"),
                });
              } catch {
                /* Unreadable, oversized or raced entries are never catalogued. */
              }
            }
          }
        } catch {
          /* A raced directory is unavailable; continue other roots. */
        }
      };
      await walk(root, 0);
    }
    return result
      .filter((s, i, a) => a.findIndex((t) => t.locator === s.locator) === i)
      .sort((a, b) => a.locator.localeCompare(b.locator));
  }
  async metadata() {
    return (await this.scan()).map(({ path, root, ...metadata }) => metadata);
  }
  async resolve(profile: SkillProfile) {
    try {
      const found = (await this.scan()).find(
        (s) => s.locator === profile.locator && s.digest === profile.digest,
      );
      if (!found) throw changed();
      const bytes = await readSkill(found.root, found.path);
      if (createHash("sha256").update(bytes).digest("hex") !== profile.digest)
        throw changed();
      return bytes.toString("utf8");
    } catch {
      throw changed();
    }
  }
}

/** No ancestor/home scan: one selected project root and existing explicit global roots. */
export function projectSkillCatalog(
  startingFolder: string,
  globalRoots: string[],
) {
  const roots = [
    {
      path: join(startingFolder, ".agents", "skills"),
      source: "project" as const,
    },
    ...globalRoots
      .slice(0, 15)
      .map((path) => ({ path: resolve(path), source: "global" as const })),
  ];
  const catalog = new SkillCatalog(roots.map((root) => root.path));
  return {
    async metadata(): Promise<
      import("../../shared/src/project-settings.js").ProjectSkillMetadata[]
    > {
      const scanned = await catalog.scan();
      const result: import("../../shared/src/project-settings.js").ProjectSkillMetadata[] =
        [];
      for (const skill of scanned) {
        const source = roots.find((root) => root.path === skill.root);
        if (!source) continue;
        const text = (await readSkill(skill.root, skill.path)).toString("utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
          text,
        )?.[1];
        const field = (name: string) =>
          frontmatter
            ?.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
            ?.trim()
            .replace(/^["']|["']$/g, "")
            .slice(0, 300);
        result.push({
          locator: skill.locator,
          digest: skill.digest,
          name: field("name") || skill.name,
          ...(field("description")
            ? { description: field("description") }
            : {}),
          source: source.source,
          sourceRoot: skill.root,
        });
      }
      return result;
    },
    resolve: (profile: SkillProfile) => catalog.resolve(profile),
  };
}

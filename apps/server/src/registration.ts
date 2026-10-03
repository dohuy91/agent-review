import { lstat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type {
  Repository,
  RepositoryRestoreError,
  RepositoryContext,
} from "../../../packages/shared/src/index.js";
import { registerRepository } from "./registry.js";
async function physicalIdentity(repo: Repository) {
  return JSON.stringify(
    await Promise.all(
      [repo.root, repo.gitDir, repo.commonDir].map(async (path) => {
        const stat = await lstat(path, { bigint: true });
        if (!stat.isDirectory()) throw new Error("Unsafe registered directory");
        return [stat.dev.toString(), stat.ino.toString()];
      }),
    ),
  );
}
/** Only explicitly registered canonical root identities are retained, never source. */
export class RegistrationStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS registered_roots(id TEXT PRIMARY KEY, root TEXT NOT NULL, git_dir TEXT NOT NULL, common_dir TEXT NOT NULL, project_id TEXT NOT NULL, identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_selection(singleton INTEGER PRIMARY KEY CHECK(singleton=1), repository_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_context(repository_id TEXT PRIMARY KEY, base TEXT NOT NULL, mode TEXT NOT NULL);`);
    const columns = db
      .prepare("PRAGMA table_info(registration_context)")
      .all() as { name: string }[];
    if (!columns.some((column) => column.name === "target"))
      db.exec("ALTER TABLE registration_context ADD COLUMN target TEXT");
  }
  async save(repo: Repository) {
    const identity = await physicalIdentity(repo);
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM registered_roots")
      .get() as { count: number };
    if (
      count.count >= 128 &&
      !this.db
        .prepare("SELECT id FROM registered_roots WHERE id=?")
        .get(repo.id)
    )
      throw new Error("Registered project limit reached");
    this.db
      .prepare(
        "INSERT INTO registered_roots VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,git_dir=excluded.git_dir,common_dir=excluded.common_dir,project_id=excluded.project_id,identity=excluded.identity",
      )
      .run(
        repo.id,
        repo.root,
        repo.gitDir,
        repo.commonDir,
        repo.projectId,
        identity,
      );
  }
  select(id: string) {
    this.db
      .prepare(
        "INSERT INTO registration_selection VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET repository_id=excluded.repository_id",
      )
      .run(id);
  }
  selected(): string | null {
    return (
      (
        this.db
          .prepare(
            "SELECT repository_id FROM registration_selection WHERE singleton=1",
          )
          .get() as { repository_id: string } | undefined
      )?.repository_id ?? null
    );
  }
  saveContext(id: string, context: RepositoryContext) {
    this.db
      .prepare(
        "INSERT INTO registration_context(repository_id,base,mode,target) VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET base=excluded.base,mode=excluded.mode,target=excluded.target",
      )
      .run(id, context.base, context.mode, context.target ?? null);
  }
  context(id: string): RepositoryContext | null {
    const row = this.db
      .prepare(
        "SELECT base,mode,target FROM registration_context WHERE repository_id=?",
      )
      .get(id) as RepositoryContext | undefined;
    return row &&
      ["full", "branch", "working", "staged"].includes(row.mode) &&
      typeof row.base === "string" &&
      row.base.length <= 4096 &&
      (row.target === null ||
        row.target === undefined ||
        (typeof row.target === "string" &&
          row.target.startsWith("refs/heads/") &&
          row.target.length <= 4096))
      ? {
          base: row.base,
          mode: row.mode,
          ...(row.target ? { target: row.target } : {}),
        }
      : null;
  }
  async restore(validate: (repo: Repository) => void) {
    const repositories: Repository[] = [],
      errors: RepositoryRestoreError[] = [];
    const saved = this.db
      .prepare("SELECT * FROM registered_roots ORDER BY rowid LIMIT 128")
      .all() as {
      id: string;
      root: string;
      git_dir: string;
      common_dir: string;
      project_id: string;
      identity: string;
    }[];
    for (const row of saved) {
      try {
        const repo = await registerRepository(row.root);
        if (
          repo.id !== row.id ||
          repo.root !== row.root ||
          repo.gitDir !== row.git_dir ||
          repo.commonDir !== row.common_dir ||
          repo.projectId !== row.project_id ||
          (await physicalIdentity(repo)) !== row.identity
        )
          throw new Error("Registered identity changed");
        validate(repo);
        repositories.push(repo);
      } catch {
        errors.push({
          root: row.root,
          error:
            "Registered root is unavailable, inaccessible, or its canonical identity changed. Reopen the exact repository when available.",
        });
      }
    }
    return { repositories, errors };
  }
}

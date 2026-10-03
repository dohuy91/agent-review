import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Repository,
  ReviewObservation,
  GitActionResult,
} from "../../shared/src/index.js";
import { registerRepository } from "../../../apps/server/src/registry.js";
import {
  git,
  gitText,
  readWorktree,
  safeStat,
  validPath,
  DISPLAY_LIMIT,
  readIndexBytes,
} from "./git.js";
import { StaleReviewError } from "./review.js";
import { getFileDiff } from "./diff.js";

export class GitActionError extends Error {
  constructor(
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export type Revalidate = () => Promise<void>;
export class RepositoryQueue {
  private pending = new Map<string, Promise<unknown>>();
  isBusy(id: string) {
    return this.pending.has(id);
  }
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(action);
    this.pending.set(id, result);
    try {
      return await result;
    } finally {
      if (this.pending.get(id) === result) this.pending.delete(id);
    }
  }
}
const prefix = [
  "--no-pager",
  "--no-lazy-fetch",
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "commit.gpgSign=false",
  "-c",
  "tag.gpgSign=false",
  "-c",
  "user.useConfigOnly=true",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.splitIndex=false",
];
/** Internal plumbing only. HTTP cannot supply any argv, input, index path or environment. */
export async function writeGit(
  repo: Repository,
  args: string[],
  input?: Buffer,
  index?: string,
): Promise<Buffer> {
  if (
    ![
      "hash-object",
      "read-tree",
      "update-index",
      "write-tree",
      "commit-tree",
      "update-ref",
    ].includes(args[0]!)
  )
    throw new GitActionError("Unsupported Git operation");
  await validateWriteDestinations(repo, {
    objects: true,
    ...(args[0] === "update-ref" ? { branch: args.at(-3)! } : {}),
  });
  return executeWriteGit(repo, args, input, index);
}
/** Narrow checkout/stash porcelain. Callers must validate a one-use, clean or explicitly
 * approved save plan immediately before entry. No HTTP argv reaches this boundary. */
export async function writeBranchGit(
  repo: Repository,
  args: string[],
): Promise<Buffer> {
  const switching =
    args.length === 6 &&
    args.slice(0, 5).join("\0") ===
      [
        "switch",
        "--no-guess",
        "--no-recurse-submodules",
        "--no-overwrite-ignore",
        "--",
      ].join("\0") &&
    !!args[5] &&
    !args[5].startsWith("-") &&
    !/[\x00-\x20\x7f]/.test(args[5]);
  const stashing =
    args.length === 5 &&
    args.slice(0, 4).join("\0") ===
      ["stash", "push", "--include-untracked", "--message"].join("\0") &&
    /^agent-review branch switch [0-9a-f-]{36} from refs\/heads\//.test(
      args[4]!,
    ) &&
    !/[\x00-\x1f\x7f]/.test(args[4]!) &&
    args[4]!.length <= 4300;
  if (!switching && !stashing)
    throw new GitActionError("Unsupported branch operation");
  if (switching)
    await git(repo.root, ["check-ref-format", `refs/heads/${args[5]}`]);
  await validateWriteDestinations(repo, { objects: stashing });
  return executeWriteGit(
    repo,
    args,
    undefined,
    undefined,
    [
      "-c",
      "submodule.recurse=false",
      "-c",
      "gc.auto=0",
      "-c",
      "maintenance.auto=false",
      "-c",
      "core.warnAmbiguousRefs=true",
      "-c",
      "stash.showStat=false",
      "-c",
      "stash.showPatch=false",
      "-c",
      "core.trustctime=true",
      "-c",
      "core.checkStat=default",
      "-c",
      "core.ignoreStat=false",
      "-c",
      "core.fileMode=true",
    ],
    !stashing,
  );
}
/** Fixed merge lifecycle porcelain only; caller owns exact-state preview revalidation. */
export async function writeMergeGit(
  repo: Repository,
  operation: "pull" | "continue" | "abort",
  head?: string,
): Promise<Buffer> {
  if (
    !["pull", "continue", "abort"].includes(operation) ||
    (operation === "pull" && !/^[a-f0-9]{40,64}$/.test(head ?? ""))
  )
    throw new GitActionError("Unsupported merge operation");
  const actual = await validateIdentity(repo);
  if (!actual.branch?.startsWith("refs/heads/"))
    throw new GitActionError(
      "Select a checked-out local branch before merging",
    );
  await validateWriteDestinations(repo, {
    objects: true,
    branch: actual.branch,
  });
  const args =
    operation === "pull"
      ? [
          "merge",
          "--no-edit",
          "--no-stat",
          "--no-progress",
          "--no-autostash",
          "--no-overwrite-ignore",
          "--no-gpg-sign",
          "--strategy=ort",
          "--",
          head!,
        ]
      : operation === "continue"
        ? ["commit", "--no-edit", "--no-gpg-sign", "--no-verify"]
        : ["merge", "--abort"];
  return executeWriteGit(repo, args, undefined, undefined, [
    "-c",
    "submodule.recurse=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "rerere.enabled=false",
    "-c",
    "rerere.autoupdate=false",
    "-c",
    "merge.autoStash=false",
    "-c",
    "merge.stat=false",
    "-c",
    "merge.renormalize=false",
    "-c",
    "core.trustctime=true",
    "-c",
    "core.checkStat=default",
    "-c",
    "core.ignoreStat=false",
    "-c",
    "core.fileMode=true",
    "-c",
    "core.editor=true",
    "-c",
    "sequence.editor=true",
  ]);
}
async function executeWriteGit(
  repo: Repository,
  args: string[],
  input?: Buffer,
  index?: string,
  additional: string[] = [],
  literalPathspecs = true,
): Promise<Buffer> {
  // update-index may inspect racily-clean worktree entries while writing. Disable
  // every effective filter driver, even though our selected blob uses --no-filters.
  let keys = "";
  try {
    keys = (
      await git(repo.root, [
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ])
    ).toString("utf8");
  } catch (e) {
    if ((e as { code?: number }).code !== 1) throw e;
  }
  const filters: string[] = [];
  for (const driver of new Set(
    keys
      .split("\0")
      .filter(Boolean)
      .map((k) => k.replace(/\.(clean|smudge|process|required)$/, "")),
  ))
    filters.push(
      "-c",
      `${driver}.clean=`,
      "-c",
      `${driver}.smudge=`,
      "-c",
      `${driver}.process=`,
      "-c",
      `${driver}.required=false`,
    );
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  Object.assign(env, {
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  });
  // Git stash itself builds :(literal) pathspecs for saved untracked files.
  // An inherited global literal override makes that safe internal clean a no-op.
  // This fixed stash invocation accepts no caller-supplied paths or pathspecs.
  if (!literalPathspecs) delete env.GIT_LITERAL_PATHSPECS;
  if (index) env.GIT_INDEX_FILE = index;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        ...prefix.filter(
          (arg) => literalPathspecs || arg !== "--literal-pathspecs",
        ),
        ...filters,
        ...additional,
        "-C",
        repo.root,
        ...args,
      ],
      {
        encoding: "buffer",
        shell: false,
        env,
        timeout: 10000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) =>
        error
          ? reject(
              new GitActionError(
                "Git operation failed; check repository state and local configuration",
              ),
            )
          : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
export async function validateIdentity(
  repo: Repository,
  expected?: Pick<ReviewObservation, "head" | "branch">,
) {
  try {
    for (const path of [repo.root, repo.gitDir, repo.commonDir])
      if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory())
        throw new StaleReviewError();
    const current = await registerRepository(repo.root);
    if (
      (["id", "root", "gitDir", "commonDir", "projectId"] as const).some(
        (k) => current[k] !== repo[k],
      ) ||
      (expected &&
        (current.head !== expected.head || current.branch !== expected.branch))
    )
      throw new StaleReviewError();
    return current;
  } catch {
    throw new StaleReviewError();
  }
}
/** Validate concrete Git write destinations, not only the registered top-level identity.
 * Existing aliases are refused even if their current destination remains inside the repo.
 * Each invocation is bounded and repeated immediately before each plumbing/transport write.
 */
export async function validateWriteDestinations(
  repo: Repository,
  targets: { objects?: boolean; branch?: string; remote?: string },
) {
  await validateIdentity(repo);
  let backend = "files";
  try {
    backend = await gitText(repo.root, [
      "config",
      "--get",
      "extensions.refStorage",
    ]);
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
  if (backend !== "files")
    throw new GitActionError(
      "This Git reference storage layout is unsupported for safe writes",
    );
  let inspected = 0;
  const refuse = () =>
    new GitActionError(
      "Git metadata write destinations contain an unsafe alias or shared append target; repair the layout with Git before retrying",
    );
  async function node(
    path: string,
    kind: "file" | "directory",
    recursive = false,
    shared = false,
  ) {
    if (++inspected > 20000)
      throw new GitActionError(
        "Git metadata exceeds the safe validation limit; use Git directly",
      );
    let stat;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
      (shared && stat.isFile() && stat.nlink !== 1n)
    )
      throw refuse();
    if (recursive && stat.isDirectory())
      for (const name of await readdir(path)) {
        const child = join(path, name);
        const childStat = await lstat(child);
        await node(
          child,
          childStat.isDirectory() ? "directory" : "file",
          true,
          shared,
        );
      }
    const after = await lstat(path, { bigint: true });
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.isSymbolicLink()
    )
      throw refuse();
  }
  async function destination(
    root: string,
    path: string,
    kind: "file" | "directory",
    recursive = false,
    shared = false,
  ) {
    validPath(path);
    let current = root;
    const parts = path.split("/");
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      await node(
        current,
        i === parts.length - 1 ? kind : "directory",
        i === parts.length - 1 && recursive,
        shared,
      );
    }
  }
  if (targets.objects) {
    await destination(repo.commonDir, "objects", "directory", true);
  }
  if (targets.branch || targets.remote) {
    await destination(repo.commonDir, "packed-refs", "file", false, true);
    await destination(repo.commonDir, "packed-refs.lock", "file", false, true);
  }
  if (targets.branch) {
    if (!targets.branch.startsWith("refs/heads/"))
      throw new GitActionError("Only exact local branch updates are supported");
    await destination(repo.commonDir, targets.branch, "file", false, true);
    await destination(
      repo.commonDir,
      targets.branch + ".lock",
      "file",
      false,
      true,
    );
    await destination(
      repo.commonDir,
      "logs/" + targets.branch,
      "file",
      false,
      true,
    );
    await destination(repo.gitDir, "logs/HEAD", "file", false, true);
  }
  if (targets.remote) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targets.remote) ||
      targets.remote.includes("..") ||
      targets.remote.endsWith(".lock")
    )
      throw new GitActionError("Unsupported remote reference namespace");
    await destination(
      repo.commonDir,
      "refs/remotes/" + targets.remote,
      "directory",
      true,
      true,
    );
    await destination(
      repo.commonDir,
      "logs/refs/remotes/" + targets.remote,
      "directory",
      true,
      true,
    );
    await destination(repo.commonDir, "shallow", "file", false, true);
    await destination(repo.commonDir, "shallow.lock", "file", false, true);
  }
}
async function indexSnapshot(repo: Repository) {
  const path = join(repo.gitDir, "index");
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(16 * 1024 * 1024))
      throw new GitActionError("Unsafe or oversized Git index", 409);
    const bytes = await readIndexBytes(repo.gitDir);
    const after = await lstat(path, { bigint: true });
    if (
      !bytes ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new StaleReviewError();
    return {
      bytes,
      identity: `${before.dev}:${before.ino}:${before.size}:${before.ctimeNs}:${before.mtimeNs}`,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { bytes: null, identity: null };
    throw e;
  }
}
export async function withIndexLock<T>(
  repo: Repository,
  action: (guard: {
    bytes: Buffer | null;
    verify: Revalidate;
    publish: (bytes: Buffer) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  await validateIdentity(repo);
  const path = join(repo.gitDir, "index.lock");
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new GitActionError(
      "Git index is locked or unsafe; finish the other Git operation and refresh",
      409,
    );
  }
  const owned = await handle.stat({ bigint: true });
  let published = false;
  const owns = async () => {
    try {
      const s = await lstat(path, { bigint: true });
      return (
        s.isFile() &&
        s.ino === owned.ino &&
        s.dev === owned.dev &&
        s.nlink === 1n
      );
    } catch {
      return false;
    }
  };
  try {
    const snapshot = await indexSnapshot(repo);
    const verify = async () => {
      await validateIdentity(repo);
      if (!(await owns())) throw new StaleReviewError();
      const next = await indexSnapshot(repo);
      if (
        next.identity !== snapshot.identity ||
        !(
          (next.bytes === null && snapshot.bytes === null) ||
          (next.bytes && snapshot.bytes && next.bytes.equals(snapshot.bytes))
        )
      )
        throw new StaleReviewError();
    };
    return await action({
      bytes: snapshot.bytes,
      verify,
      publish: async (bytes) => {
        await verify();
        await handle.writeFile(bytes);
        await handle.sync();
        await verify();
        await rename(path, join(repo.gitDir, "index"));
        published = true;
      },
    });
  } finally {
    await handle.close();
    if (!published && (await owns())) await unlink(path);
  }
}
export async function withTemporaryIndex<T>(
  repo: Repository,
  initial: Buffer | null,
  action: (index: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "agent-review-index-"));
  try {
    const canonical = await realpath(directory);
    const rel = relative(repo.root, canonical);
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")))
      throw new GitActionError(
        "Temporary index must be outside the reviewed worktree",
      );
    const index = join(directory, "index");
    if (initial) await writeFile(index, initial, { mode: 0o600, flag: "wx" });
    return await action(index);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
  intentToAdd?: boolean;
}
export function exactText(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes))
    throw new GitActionError(
      "Non-UTF-8 Git paths are unsupported; use Git directly for this repository",
    );
  return text;
}
export async function indexEntries(repo: Repository): Promise<IndexEntry[]> {
  // Git's debug record exposes extended index flags. Parse the entire bounded,
  // NUL-path record conservatively; unknown formats cannot authorize a write.
  const data = exactText(
    await git(repo.root, ["ls-files", "--stage", "--debug", "-z"]),
  );
  const result: IndexEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const end = data.indexOf("\0", at);
    if (end < 0)
      throw new GitActionError("Index entry state cannot be verified");
    const header = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(
      data.slice(at, end),
    );
    const detail =
      /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([a-fA-F0-9]+)\n/.exec(
        data.slice(end + 1),
      );
    if (!header || !detail)
      throw new GitActionError(
        "Index entry state cannot be verified; use Git directly",
      );
    result.push({
      mode: header[1]!,
      oid: header[2]!,
      stage: Number(header[3]),
      path: header[4]!,
      intentToAdd: (Number.parseInt(detail[1]!, 16) & 0x20000000) !== 0,
    });
    at = end + 1 + detail[0].length;
  }
  return result;
}
export async function headEntry(
  repo: Repository,
  head: string,
  path: string,
): Promise<IndexEntry | null> {
  const data = exactText(
    await git(repo.root, ["ls-tree", "-z", head, "--", path]),
  )
    .split("\0")
    .filter(Boolean);
  const row = data.find((row) => row.slice(row.indexOf("\t") + 1) === path);
  if (!row) return null;
  const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t/.exec(row);
  if (!m) throw new GitActionError("Only regular files are supported");
  return { mode: m[1]!, oid: m[2]!, stage: 0, path };
}
export function regularEntry(entry: IndexEntry | null) {
  if (
    entry &&
    (entry.stage !== 0 || !["100644", "100755"].includes(entry.mode))
  )
    throw new GitActionError(
      "Only regular, non-conflicted files are supported",
    );
}
export async function indexEntry(repo: Repository, path: string) {
  const entries = (await indexEntries(repo)).filter((e) => e.path === path);
  if (entries.length > 1)
    throw new GitActionError("Resolve this file conflict in Git first");
  const entry = entries[0] ?? null;
  regularEntry(entry);
  return entry;
}
export async function entryBytes(repo: Repository, entry: IndexEntry | null) {
  if (!entry) return null;
  regularEntry(entry);
  if (
    Number(await gitText(repo.root, ["cat-file", "-s", entry.oid])) >
    DISPLAY_LIMIT
  )
    throw new GitActionError("File exceeds safe operation size limit");
  return git(repo.root, ["cat-file", "blob", entry.oid]);
}
export function indexInfo(
  path: string,
  entry: IndexEntry | null,
  oidLength = 40,
) {
  return Buffer.from(
    entry
      ? `${entry.mode} ${entry.oid}\t${path}\0`
      : `0 ${"0".repeat(oidLength)}\t${path}\0`,
  );
}
export async function assertReviewFile(
  repo: Repository,
  o: ReviewObservation,
  path: string,
) {
  validPath(path);
  if (Buffer.from(path).toString("utf8") !== path)
    throw new GitActionError(
      "Non-UTF-8 paths are unsupported; use Git directly",
    );
  exactText(
    await git(repo.root, ["ls-tree", "-r", "-z", "--name-only", o.head]),
  );
  if (new Set(o.files.map((file) => file.path)).size !== o.files.length)
    throw new GitActionError(
      "Ambiguous review paths are unsupported; use Git directly",
    );
  exactText(
    await git(repo.root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  );
  if (o.historical) throw new StaleReviewError();
  const f = o.files.find((f) => f.path === path);
  if (!f) throw new GitActionError("Select a file in the current review");
  if (f.kind !== "text")
    throw new GitActionError(
      "Only regular, non-conflicted files are supported",
    );
  const s = await safeStat(repo.root, path);
  if (s && !s.isFile())
    throw new GitActionError("Symlinks and special files cannot be changed");
  return f;
}
async function worktreeBytes(repo: Repository, path: string) {
  try {
    return await readWorktree(repo.root, path);
  } catch (error) {
    if (/display limit/.test((error as Error).message))
      throw new GitActionError(
        "File exceeds safe operation size limit; use Git directly",
      );
    throw new GitActionError(
      "File changed or cannot be read safely; refresh before retrying",
      409,
    );
  }
}
function splitLines(content: string) {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
export async function mutateIndex(
  repo: Repository,
  o: ReviewObservation,
  path: string,
  action: "stage" | "unstage",
  hunkIndex: number | undefined,
  revalidate: Revalidate,
): Promise<GitActionResult> {
  return withIndexLock(repo, async (guard) => {
    await revalidate();
    await validateIdentity(repo, o);
    const file = await assertReviewFile(repo, o, path);
    const current = await indexEntry(repo, path);
    const head = await headEntry(repo, o.head, path);
    regularEntry(head);
    let desired: IndexEntry | null;
    if (hunkIndex !== undefined) {
      if (o.mode !== (action === "stage" ? "working" : "staged"))
        throw new GitActionError(
          action === "stage"
            ? "Switch to Working to stage a hunk"
            : "Switch to Staged to unstage a hunk",
        );
      if (
        file.oldPath ||
        !["000000", "100644", "100755"].includes(file.oldMode) ||
        !["000000", "100644", "100755"].includes(file.newMode)
      )
        throw new GitActionError("Use whole-file actions for this file");
      const diff = await getFileDiff(repo, o, path);
      const h = diff.hunks[hunkIndex];
      if (diff.unsupportedReason || !h)
        throw new GitActionError(
          "This hunk is unavailable; use a supported whole-file action",
        );
      const rawOld = await entryBytes(
        repo,
        action === "stage" ? (current?.intentToAdd ? null : current) : head,
      );
      const rawNext =
        action === "stage"
          ? await worktreeBytes(repo, path)
          : await entryBytes(repo, current);
      if (
        (rawOld && !Buffer.from(diff.oldContent ?? "").equals(rawOld)) ||
        (rawNext && !Buffer.from(diff.newContent ?? "").equals(rawNext))
      )
        throw new GitActionError(
          "Hunks require lossless UTF-8 text; use the whole file",
        );
      const old = splitLines(diff.oldContent ?? "");
      const next = splitLines(diff.newContent ?? "");
      const oldAt = h.oldCount ? h.oldStart - 1 : h.oldStart;
      const newAt = h.newCount ? h.newStart - 1 : h.newStart;
      const expectedOld = h.lines
        .filter((l) => l.type !== "add")
        .map((l) => l.text);
      const expectedNew = h.lines
        .filter((l) => l.type !== "delete")
        .map((l) => l.text);
      const text = (lines: string[]) =>
        lines.map((l) => (l.endsWith("\n") ? l.slice(0, -1) : l));
      if (
        JSON.stringify(text(old.slice(oldAt, oldAt + h.oldCount))) !==
          JSON.stringify(expectedOld) ||
        JSON.stringify(text(next.slice(newAt, newAt + h.newCount))) !==
          JSON.stringify(expectedNew)
      )
        throw new GitActionError(
          "Hunk context cannot be applied exactly; use the whole file",
        );
      const before = await entryBytes(
        repo,
        current?.intentToAdd ? null : current,
      );
      const source = action === "stage" ? diff.oldContent : diff.newContent;
      if ((before?.toString("utf8") ?? null) !== source)
        throw new StaleReviewError();
      const lines =
        action === "stage"
          ? [
              ...old.slice(0, oldAt),
              ...next.slice(newAt, newAt + h.newCount),
              ...old.slice(oldAt + h.oldCount),
            ]
          : [
              ...next.slice(0, newAt),
              ...old.slice(oldAt, oldAt + h.oldCount),
              ...next.slice(newAt + h.newCount),
            ];
      const bytes = Buffer.from(lines.join(""));
      const removal =
        action === "stage"
          ? diff.newContent === null
          : diff.oldContent === null;
      desired =
        removal && bytes.length === 0
          ? null
          : {
              path,
              stage: 0,
              mode:
                (action === "stage"
                  ? (current?.mode ?? file.newMode)
                  : (current?.mode ?? head?.mode)) ?? "100644",
              oid: (
                await writeGit(
                  repo,
                  ["hash-object", "-w", "--stdin", "--no-filters"],
                  bytes,
                )
              )
                .toString("utf8")
                .trim(),
            };
    } else if (action === "unstage") {
      desired = head;
    } else {
      const bytes = await worktreeBytes(repo, path);
      const stat = await safeStat(repo.root, path);
      desired =
        bytes === null
          ? null
          : {
              path,
              stage: 0,
              mode: stat && (stat.mode & 0o111n) !== 0n ? "100755" : "100644",
              oid: (
                await writeGit(
                  repo,
                  ["hash-object", "-w", "--stdin", "--no-filters"],
                  bytes,
                )
              )
                .toString("utf8")
                .trim(),
            };
    }
    if (
      !current?.intentToAdd &&
      (current?.mode ?? null) === (desired?.mode ?? null) &&
      (current?.oid ?? null) === (desired?.oid ?? null)
    )
      return { ok: true, changed: false };
    await withTemporaryIndex(repo, guard.bytes, async (index) => {
      if (!guard.bytes)
        await writeGit(repo, ["read-tree", "--empty"], undefined, index);
      await writeGit(
        repo,
        ["update-index", "-z", "--index-info"],
        indexInfo(path, desired, o.head.length),
        index,
      );
      await revalidate();
      await validateIdentity(repo, o);
      await guard.verify();
      await guard.publish(await readFile(index));
    });
    return { ok: true, changed: true };
  });
}
export async function discardFile(
  repo: Repository,
  o: ReviewObservation,
  path: string,
  revalidate: Revalidate,
): Promise<GitActionResult> {
  return withIndexLock(repo, async (guard) => {
    await revalidate();
    await validateIdentity(repo, o);
    await assertReviewFile(repo, o, path);
    const entry = await indexEntry(repo, path);
    const bytes = await entryBytes(repo, entry);
    const current = await worktreeBytes(repo, path);
    const currentStat = await safeStat(repo.root, path);
    const modeMatches =
      !entry ||
      (!!currentStat &&
        ((currentStat.mode & 0o111n) !== 0n) === (entry.mode === "100755"));
    if (
      (modeMatches &&
        current?.equals(bytes ?? Buffer.alloc(0)) &&
        bytes !== null) ||
      (current === null && bytes === null)
    )
      return { ok: true, changed: false };
    const absolute = join(repo.root, path);
    const parent = dirname(absolute);
    let canonicalParent: string | null = null;
    try {
      canonicalParent = await realpath(parent);
    } catch {}
    if (canonicalParent !== parent)
      throw new GitActionError(
        "Restore the missing or unsafe parent directory in Git first",
      );
    const before = await safeStat(repo.root, path);
    const parentStat = await lstat(parent, { bigint: true });
    const validatePath = async () => {
      await revalidate();
      await validateIdentity(repo, o);
      await guard.verify();
      if ((await realpath(parent)) !== parent) throw new StaleReviewError();
      const p = await lstat(parent, { bigint: true });
      const s = await safeStat(repo.root, path);
      if (
        p.ino !== parentStat.ino ||
        p.dev !== parentStat.dev ||
        s?.ino !== before?.ino ||
        s?.ctimeNs !== before?.ctimeNs
      )
        throw new StaleReviewError();
    };
    if (bytes === null) {
      await validatePath();
      if (before) await unlink(absolute);
    } else {
      // No checkout/conversion/filter. Atomic replacement never opens the target for writing.
      const temporary = join(repo.gitDir, `.agent-review-${randomUUID()}`);
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        const permissions = before
          ? Number(before.mode & 0o666n)
          : 0o666 & ~process.umask();
        await handle.chmod(
          permissions |
            (entry?.mode === "100755" ? (permissions & 0o444) >> 2 : 0),
        );
        await handle.sync();
        await handle.close();
        await validatePath();
        await rename(temporary, absolute);
      } finally {
        await handle.close().catch(() => {});
        await rm(temporary, { force: true });
      }
    }
    return { ok: true, changed: true };
  });
}

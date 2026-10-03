import { lstatSync, realpathSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import type { Repository } from "../../../packages/shared/src/index.js";
import type {
  FetchAllResult,
  GitSyncSettings,
  MergePreview,
  PullPreview,
  RepositorySync,
  SyncMutationResult,
  SyncRemoteStatus,
  SyncSettings,
} from "../../../packages/shared/src/sync.js";
import type { ReviewStore } from "../../../packages/review/src/store.js";
import { agentDefaults } from "../../../packages/agents/src/defaults.js";
import {
  GitActionError,
  RepositoryQueue,
  validateIdentity,
} from "../../../packages/git/src/mutations.js";
import {
  fetchRemote,
  getRemotes,
  readRemoteConfiguration,
  type FetchTransport,
} from "../../../packages/git/src/remotes.js";
import {
  applyMerge,
  applyPull,
  prepareMerge,
  preparePull,
  readMergeState,
} from "../../../packages/git/src/merge.js";
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
export interface SyncOptions {
  queue?: RepositoryQueue;
  enableWrites?: boolean;
  container?: boolean;
  fetchTransport?: FetchTransport;
  now?: () => number;
  assertIdle?: (repositoryId: string) => Promise<void> | void;
  /** Revalidate only the bounded saved registrations, never discover new roots. */
  beforeTick?: () => Promise<void>;
  /** Saved physical authorization from validated registration, not a later live observation. */
  admissionIdentity?: (repo: Repository) => string | null;
  /** Internal timer seam, never configurable through HTTP. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}
interface RemoteRecord {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  failures: number;
  configurationStamp?: string;
}
type Plan = { repositoryId: string; stamp: string; expires: number } & (
  | { kind: "pull"; preview: PullPreview }
  | { kind: "merge"; preview: MergePreview }
);
const emptyMerge = {
  pending: false,
  mergeHeads: [],
  conflicts: [],
  canContinue: false,
  reason: null,
};
export class SyncService {
  private queue: RepositoryQueue;
  private now: () => number;
  private writesEnabled: boolean;
  private operations = new Map<string, Promise<unknown>>();
  private fetching = new Set<string>();
  private ticks = new Set<Promise<void>>();
  private plans = new Map<string, Plan>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private identities = new WeakMap<Repository, string | null>();
  constructor(
    private repositories: Map<string, Repository>,
    private store: ReviewStore,
    private options: SyncOptions = {},
  ) {
    this.queue = options.queue ?? new RepositoryQueue();
    this.now = options.now ?? Date.now;
    this.writesEnabled =
      options.enableWrites ?? agentDefaults(options.container).enableWrites;
    for (const repo of repositories.values()) this.admitRepository(repo);
    store.db
      .exec(`CREATE TABLE IF NOT EXISTS sync_preferences(singleton INTEGER PRIMARY KEY CHECK(singleton=1),auto_fetch_enabled INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sync_remote_status(project_id TEXT NOT NULL,remote TEXT NOT NULL,metadata TEXT NOT NULL,PRIMARY KEY(project_id,remote));
  CREATE TABLE IF NOT EXISTS sync_git_settings(project_id TEXT PRIMARY KEY,default_remote TEXT);`);
  }
  private directoryStamp(repo: Repository): string | null {
    try {
      return JSON.stringify(
        [repo.root, repo.gitDir, repo.commonDir].map((path) => {
          const stat = lstatSync(path, { bigint: true });
          if (!stat.isDirectory() || realpathSync(path) !== path)
            throw new Error("Unsafe directory");
          return [String(stat.dev), String(stat.ino)];
        }),
      );
    } catch {
      return null;
    }
  }
  /** Call synchronously at the validated registration/restore admission, before yielding. */
  admitRepository(repo: Repository): void {
    // Repeated admission cannot replace an existing object's physical authorization.
    if (!this.identities.has(repo))
      this.identities.set(
        repo,
        this.options.admissionIdentity
          ? this.options.admissionIdentity(repo)
          : this.directoryStamp(repo),
      );
  }
  private registeredIdentity(repo: Repository) {
    const expected = this.identities.get(repo);
    if (!expected || expected !== this.directoryStamp(repo))
      throw new GitActionError(
        "Registered project identity changed, is unavailable or was not admitted; reopen the exact repository before synchronizing",
        409,
      );
  }
  settings(): SyncSettings {
    const row = this.store.db
      .prepare(
        "SELECT auto_fetch_enabled FROM sync_preferences WHERE singleton=1",
      )
      .get() as { auto_fetch_enabled: number } | undefined;
    return {
      autoFetchEnabled: row?.auto_fetch_enabled !== 0,
      intervalMs: SYNC_INTERVAL_MS,
    };
  }
  setSettings(enabled: boolean): SyncSettings {
    this.store.db
      .prepare(
        "INSERT INTO sync_preferences VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET auto_fetch_enabled=excluded.auto_fetch_enabled",
      )
      .run(enabled ? 1 : 0);
    return this.settings();
  }
  gitSettings(id: string): GitSyncSettings {
    const repo = this.repository(id);
    const row = this.store.db
      .prepare(
        "SELECT default_remote FROM sync_git_settings WHERE project_id=?",
      )
      .get(repo.projectId) as { default_remote: string | null } | undefined;
    return { defaultRemote: row?.default_remote ?? null };
  }
  async setGitSettings(
    id: string,
    remote: string | null,
  ): Promise<GitSyncSettings> {
    const repo = this.repository(id);
    if (
      remote !== null &&
      (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote) ||
        !(await getRemotes(repo)).some((r) => r.name === remote))
    )
      throw new GitActionError("Choose a configured named remote");
    this.store.db
      .prepare(
        "INSERT INTO sync_git_settings VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET default_remote=excluded.default_remote",
      )
      .run(repo.projectId, remote);
    return this.gitSettings(id);
  }
  private repository(id: string) {
    const repo = this.repositories.get(id);
    if (!repo) throw new GitActionError("Repository is not registered", 404);
    return repo;
  }
  private writable() {
    if (!this.writesEnabled)
      throw new GitActionError("Writes are disabled for this environment", 403);
  }
  private record(repo: Repository, remote: string): RemoteRecord {
    const row = this.store.db
      .prepare(
        "SELECT metadata FROM sync_remote_status WHERE project_id=? AND remote=?",
      )
      .get(repo.projectId, remote) as { metadata: string } | undefined;
    return row
      ? JSON.parse(row.metadata)
      : {
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastError: null,
          nextAttemptAt: null,
          failures: 0,
        };
  }
  private save(repo: Repository, remote: string, record: RemoteRecord) {
    this.store.db
      .prepare(
        "INSERT INTO sync_remote_status VALUES(?,?,?) ON CONFLICT(project_id,remote) DO UPDATE SET metadata=excluded.metadata",
      )
      .run(repo.projectId, remote, JSON.stringify(record));
  }
  async status(id: string): Promise<RepositorySync> {
    const repo = this.repository(id),
      base = {
        repositoryId: id,
        fetching: this.fetching.has(repo.commonDir),
        writesEnabled: this.writesEnabled,
        autoFetchEnabled: this.settings().autoFetchEnabled,
      };
    try {
      this.registeredIdentity(repo);
      const actual = await validateIdentity(repo),
        remotes = await getRemotes(repo),
        merge = await readMergeState(repo);
      return {
        ...base,
        available: true,
        actual: { branch: actual.branch, head: actual.head },
        remotes: remotes.map((remote) => {
          const {
            failures: _failures,
            configurationStamp: _configurationStamp,
            ...saved
          } = this.record(repo, remote.name);
          return {
            name: remote.name,
            eligible: remote.fetchAvailable,
            reason: remote.reason,
            ...saved,
          };
        }),
        merge,
        error: null,
      };
    } catch {
      return {
        ...base,
        available: false,
        actual: null,
        remotes: [],
        merge: { ...emptyMerge },
        error:
          "Registered project is unavailable or its Git identity changed. Reopen the exact repository when available.",
      };
    }
  }
  private async exclusive<T>(
    repo: Repository,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.operations.get(repo.commonDir) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() =>
        this.queue.run(repo.id, () => {
          this.registeredIdentity(repo);
          return fn();
        }),
      );
    this.operations.set(repo.commonDir, operation);
    try {
      return await operation;
    } finally {
      if (this.operations.get(repo.commonDir) === operation)
        this.operations.delete(repo.commonDir);
    }
  }
  private async fetch(
    repo: Repository,
    names?: string[],
    automatic = false,
  ): Promise<boolean> {
    this.registeredIdentity(repo);
    const remotes = await getRemotes(repo);
    let ok = true;
    const configurationStamp = createHash("sha256")
      .update((await readRemoteConfiguration(repo)).bytes)
      .digest("hex");
    this.fetching.add(repo.commonDir);
    try {
      for (const remote of remotes) {
        if (!remote.fetchAvailable || (names && !names.includes(remote.name)))
          continue;
        const previous = this.record(repo, remote.name);
        if (
          automatic &&
          previous.configurationStamp === configurationStamp &&
          previous.lastSuccessAt &&
          this.now() - Date.parse(previous.lastSuccessAt) < SYNC_INTERVAL_MS
        )
          continue;
        if (
          automatic &&
          previous.nextAttemptAt &&
          Date.parse(previous.nextAttemptAt) > this.now()
        )
          continue;
        const attempted = {
          ...previous,
          lastAttemptAt: new Date(this.now()).toISOString(),
        };
        this.save(repo, remote.name, attempted);
        try {
          await this.options.assertIdle?.(repo.id);
          this.registeredIdentity(repo);
          const actual = await validateIdentity(repo);
          await fetchRemote(
            repo,
            remote.name,
            actual.head,
            this.options.fetchTransport,
            actual.branch,
            true,
          );
          this.save(repo, remote.name, {
            ...attempted,
            configurationStamp,
            lastSuccessAt: new Date(this.now()).toISOString(),
            lastError: null,
            nextAttemptAt: null,
            failures: 0,
          });
        } catch (error) {
          ok = false;
          const failures = Math.min(previous.failures + 1, 10);
          this.save(repo, remote.name, {
            ...attempted,
            lastError:
              error instanceof GitActionError
                ? error.message
                : "Fetch could not complete safely; check project availability and existing local authentication",
            nextAttemptAt: new Date(
              this.now() +
                Math.min(
                  SYNC_INTERVAL_MS * 2 ** (failures - 1),
                  60 * 60 * 1000,
                ),
            ).toISOString(),
            failures,
          });
        }
      }
    } finally {
      this.fetching.delete(repo.commonDir);
    }
    return ok;
  }
  async fetchAll(id: string): Promise<FetchAllResult> {
    this.writable();
    const repo = this.repository(id);
    return this.exclusive(repo, async () => ({
      ok: await this.fetch(repo),
      sync: await this.status(id),
    }));
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const task = Promise.resolve().then(() => this.tickRepositories());
    this.ticks.add(task);
    task.then(
      () => this.ticks.delete(task),
      () => this.ticks.delete(task),
    );
    return task;
  }
  private async tickRepositories(): Promise<void> {
    if (this.closed || !this.writesEnabled || !this.settings().autoFetchEnabled)
      return;
    await this.options.beforeTick?.();
    if (this.closed || !this.settings().autoFetchEnabled) return;
    const groups = new Map<string, Repository[]>();
    for (const repo of this.repositories.values())
      groups.set(repo.commonDir, [...(groups.get(repo.commonDir) ?? []), repo]);
    await Promise.all(
      [...groups.values()].map(async (group) => {
        if (
          this.operations.has(group[0].commonDir) ||
          group.some((repo) => this.queue.isBusy(repo.id))
        )
          return;
        for (const repo of group) {
          try {
            this.registeredIdentity(repo);
            await validateIdentity(repo);
            if (this.closed || this.operations.has(repo.commonDir)) return;
            await this.exclusive(repo, () => this.fetch(repo, undefined, true));
            return;
          } catch {
            /* unavailable roots never block another registered project */
          }
        }
      }),
    );
  }
  start() {
    if (this.timer || this.closed) return;
    this.timer = (this.options.setInterval ?? setInterval)(() => {
      void this.tick().catch(() => {});
    }, SYNC_INTERVAL_MS);
    this.timer.unref?.();
  }
  async close() {
    this.closed = true;
    if (this.timer) (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.ticks, ...this.operations.values()]);
  }
  private savePlan(plan: Plan) {
    while (this.plans.size >= 128)
      this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(plan.preview.previewId, plan);
  }
  private takePlan(id: string, previewId: string, kind: Plan["kind"]) {
    const plan = this.plans.get(previewId);
    this.plans.delete(previewId);
    if (
      !plan ||
      plan.repositoryId !== id ||
      plan.kind !== kind ||
      plan.expires <= this.now()
    )
      throw new GitActionError(
        "Preview expired or unavailable; refresh and preview again",
        409,
      );
    return plan;
  }
  async pullPreview(id: string, comparisonRef: string): Promise<PullPreview> {
    this.writable();
    const repo = this.repository(id);
    return this.exclusive(repo, async () => {
      await this.options.assertIdle?.(id);
      await validateIdentity(repo);
      // Determine the configured namespace before refs exist, then validate its exact mapping after fetch.
      const name =
        /^refs\/remotes\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/.+/.exec(
          comparisonRef,
        )?.[1];
      if (!name || comparisonRef.length > 4096)
        throw new GitActionError(
          "Select a configured remote-tracking comparison branch",
        );
      const remote = (await getRemotes(repo)).find((r) => r.name === name);
      if (!remote?.fetchAvailable)
        throw new GitActionError(
          remote?.reason ??
            "Select a configured eligible remote-tracking comparison branch",
        );
      const previous = this.record(repo, name);
      const configurationStamp = createHash("sha256")
        .update((await readRemoteConfiguration(repo)).bytes)
        .digest("hex");
      if (
        previous.configurationStamp !== configurationStamp ||
        !previous.lastSuccessAt ||
        this.now() - Date.parse(previous.lastSuccessAt) > SYNC_INTERVAL_MS
      )
        if (!(await this.fetch(repo, [name])))
          throw new GitActionError(
            "Pull needs a successful recent Fetch. Check existing local authentication and retry Fetch",
            502,
          );
      const snapshot = await preparePull(repo, comparisonRef),
        expires = this.now() + SYNC_INTERVAL_MS;
      const preview: PullPreview = {
        previewId: randomUUID(),
        repositoryId: id,
        worktreeRoot: repo.root,
        localBranch: snapshot.identity.branch!,
        localHead: snapshot.identity.head,
        comparisonRef,
        comparisonHead: snapshot.comparison.head,
        remote: snapshot.comparison.remote,
        operation: "merge",
        expiresAt: new Date(expires).toISOString(),
      };
      this.savePlan({
        kind: "pull",
        repositoryId: id,
        stamp: snapshot.stamp,
        expires,
        preview,
      });
      return preview;
    });
  }
  async confirmPull(
    id: string,
    previewId: string,
  ): Promise<SyncMutationResult> {
    this.writable();
    const repo = this.repository(id),
      plan = this.takePlan(id, previewId, "pull");
    if (plan.kind !== "pull") throw new GitActionError("Invalid preview");
    return this.exclusive(repo, async () => {
      await this.options.assertIdle?.(id);
      if (plan.expires <= this.now())
        throw new GitActionError(
          "Preview expired; refresh and preview again",
          409,
        );
      const outcome = await applyPull(
        repo,
        plan.preview.comparisonRef,
        plan.stamp,
        plan.preview.comparisonHead,
      );
      return { ok: true, outcome, sync: await this.status(id) };
    });
  }
  async mergePreview(
    id: string,
    action: "continue" | "abort",
  ): Promise<MergePreview> {
    this.writable();
    const repo = this.repository(id);
    return this.exclusive(repo, async () => {
      await this.options.assertIdle?.(id);
      const snapshot = await prepareMerge(repo, action),
        expires = this.now() + SYNC_INTERVAL_MS;
      const preview: MergePreview = {
        previewId: randomUUID(),
        repositoryId: id,
        worktreeRoot: repo.root,
        localBranch: snapshot.identity.branch!,
        localHead: snapshot.identity.head,
        mergeHeads: snapshot.merge.mergeHeads,
        conflicts: snapshot.merge.conflicts,
        action,
        expiresAt: new Date(expires).toISOString(),
      };
      this.savePlan({
        kind: "merge",
        repositoryId: id,
        stamp: snapshot.stamp,
        expires,
        preview,
      });
      return preview;
    });
  }
  async confirmMerge(
    id: string,
    previewId: string,
  ): Promise<SyncMutationResult> {
    this.writable();
    const repo = this.repository(id),
      plan = this.takePlan(id, previewId, "merge");
    if (plan.kind !== "merge") throw new GitActionError("Invalid preview");
    return this.exclusive(repo, async () => {
      await this.options.assertIdle?.(id);
      if (plan.expires <= this.now())
        throw new GitActionError(
          "Preview expired; refresh and preview again",
          409,
        );
      const outcome = await applyMerge(repo, plan.preview.action, plan.stamp);
      return { ok: true, outcome, sync: await this.status(id) };
    });
  }
}

import chokidar, { type FSWatcher } from "chokidar";
import { relative } from "node:path";
import type { Repository } from "../../../packages/shared/src/index.js";
/** Metadata-only invalidations: no file names or content leave the watcher. */
export class RepositoryWatch {
  readonly ready: Promise<void>;
  private watcher: FSWatcher;
  private listeners = new Set<(type: "invalidate" | "unavailable") => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private settleReadiness: () => void = () => {};
  constructor(repo: Repository) {
    const metadata = [repo.gitDir, repo.commonDir];
    const paths = [...new Set([repo.root, ...metadata])];
    this.watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p) => {
        if (
          p
            .split(/[\\/]/)
            .some((n) =>
              ["node_modules", ".pnpm-store", "dist", ".next"].includes(n),
            )
        )
          return true;
        if (metadata.includes(p)) return false;
        for (const dir of metadata) {
          const rel = relative(dir, p);
          if (rel && !rel.startsWith(".."))
            return !/^(HEAD|index|packed-refs|config|refs)(\/|$)/.test(rel);
        }
        return false;
      },
    });
    this.ready = new Promise((resolve, reject) => {
      this.settleReadiness = resolve;
      this.watcher.once("ready", resolve);
      this.watcher.once("error", reject);
    });
    this.watcher.on("all", () => {
      if (this.closed) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        for (const notify of this.listeners) notify("invalidate");
      }, 150);
    });
    this.watcher.on("error", () => {
      for (const notify of this.listeners) notify("unavailable");
    });
  }
  subscribe(notify: (type: "invalidate" | "unavailable") => void) {
    this.listeners.add(notify);
    return () => {
      this.listeners.delete(notify);
    };
  }
  async close() {
    this.closed = true;
    this.settleReadiness();
    clearTimeout(this.timer);
    this.listeners.clear();
    await this.watcher.close();
  }
}

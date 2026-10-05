import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir, platform } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from "node:path";
import type {
  DirectoryEntry,
  DirectoryListing,
  DirectoryRoot,
  DirectoryRootsResponse,
} from "../../../packages/shared/src/directories.js";

const PAGE_SIZE = 100;
const SCAN_LIMIT = 2000;
const ROOT_LIMIT = 20;
const omittedNames = new Set([
  "node_modules",
  "$RECYCLE.BIN",
  "System Volume Information",
  "__MACOSX",
]);
const systemRoots = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/System",
  "/Windows",
  "/Program Files",
  "/Program Files (x86)",
]);
const sensitiveTrees = [
  "/dev",
  "/etc",
  "/proc",
  "/run",
  "/sys",
  "/System",
  "/Windows",
];
const broadParents = new Set([
  ...systemRoots,
  "/home",
  "/Users",
  "/root",
  "/tmp",
  "/private",
  "/private/tmp",
  "/var/tmp",
  "/usr/src",
  "/usr/local",
  "/var/lib",
  "/var/log",
  "/var/cache",
  "/var/run",
  "/var/spool",
  resolve(homedir()),
  resolve(tmpdir()),
]);

interface RootRecord extends DirectoryRoot {
  configuredPaths: string[];
  identity: Stats;
}
export interface DirectoryBrowserOptions {
  repositoryPath?: string;
  browseRoots?: string[];
  container?: boolean;
  excludedPaths?: string[];
}
export class DirectoryBrowseError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return (
    part === "" ||
    (part !== ".." &&
      !part.startsWith("../") &&
      !part.startsWith("..\\") &&
      !isAbsolute(part))
  );
}
function visible(name: string) {
  return (
    !!name &&
    name !== "." &&
    name !== ".." &&
    !name.startsWith(".") &&
    !omittedNames.has(name) &&
    !/[\\:\u0000-\u001f\u007f]/u.test(name)
  );
}
function sameIdentity(first: Stats, second: Stats) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.isDirectory() &&
    second.isDirectory()
  );
}
function readable(stats: Stats) {
  // Windows does not expose POSIX execute bits for directories. The access()
  // check below remains the authority for whether this process can browse it.
  if (platform() === "win32") return true;
  // Also fail closed for mode 000 when the launcher happens to run as root.
  return (stats.mode & 0o444) !== 0 && (stats.mode & 0o111) !== 0;
}
function safeSystemPath(path: string) {
  return (
    path !== parse(path).root &&
    !systemRoots.has(path) &&
    !sensitiveTrees.some((root) => inside(root, path))
  );
}
function pathError(error: unknown): DirectoryBrowseError {
  if (error instanceof DirectoryBrowseError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM")
    return new DirectoryBrowseError(
      403,
      "Folder cannot be read. Check the server's folder permissions.",
    );
  if (code === "ENOENT" || code === "ENOTDIR")
    return new DirectoryBrowseError(
      404,
      "Folder is no longer available. Go back and choose another folder.",
    );
  return new DirectoryBrowseError(
    403,
    "Folder cannot be browsed safely. Choose another folder or restart with an explicit --browse-root.",
  );
}

function unsupportedDescriptorBrowsing() {
  return new DirectoryBrowseError(
    503,
    "Safe folder browsing is unavailable on this server. Use a Linux server with /proc/self/fd available; this platform cannot anchor folder access to an open directory.",
  );
}
async function openPinnedDirectory(path: string, expected: Stats) {
  if (platform() === "win32") {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(path);
      const identity = await lstat(path);
      if (!sameIdentity(expected, identity) || !readable(identity))
        throw new DirectoryBrowseError(
          403,
          "Folder changed before browsing. Go back and reopen it.",
        );
      return { pinned: null, handle, descriptorPath: path };
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }
  const descriptorPrefix =
    process.platform === "linux"
      ? "/proc/self/fd"
      : process.platform === "darwin"
        ? "/dev/fd"
        : null;
  if (!descriptorPrefix || !constants.O_DIRECTORY || !constants.O_NOFOLLOW)
    throw unsupportedDescriptorBrowsing();
  const pinned = await open(
    path,
    constants.O_RDONLY |
      constants.O_DIRECTORY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
  );
  try {
    const identity = await pinned.stat();
    if (!sameIdentity(expected, identity) || !readable(identity))
      throw new DirectoryBrowseError(
        403,
        "Folder changed before browsing. Go back and reopen it.",
      );
    const descriptorPath = `${descriptorPrefix}/${pinned.fd}`;
    const verifyDescriptor = async (alias: string) => {
      let resolved: Stats;
      try {
        resolved = await stat(alias);
      } catch {
        throw unsupportedDescriptorBrowsing();
      }
      if (!sameIdentity(identity, resolved))
        throw new DirectoryBrowseError(
          403,
          "Open directory identity could not be verified. Folder browsing was stopped.",
        );
    };
    await verifyDescriptor(descriptorPath);
    // Some /dev/fd implementations duplicate descriptors but cannot resolve
    // descendants. Require anchored lookup too; never fall back to pathnames.
    await verifyDescriptor(`${descriptorPath}/.`);
    let handle;
    try {
      handle = await opendir(descriptorPath);
    } catch {
      throw unsupportedDescriptorBrowsing();
    }
    try {
      await verifyDescriptor(handle.path);
      return { pinned, handle, descriptorPath };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } catch (error) {
    await pinned.close();
    throw error;
  }
}

export class DirectoryBrowser {
  private constructor(
    private roots: RootRecord[],
    private exclusions: string[],
    private container: boolean,
  ) {}
  static async create(options: DirectoryBrowserOptions) {
    const configured = [...(options.browseRoots ?? [])];
    if (configured.length > ROOT_LIMIT)
      throw new Error(
        `At most ${ROOT_LIMIT} --browse-root folders are supported`,
      );
    if (options.repositoryPath) {
      const repository = await realpath(options.repositoryPath);
      const parent = dirname(repository);
      const initial =
        !options.container &&
        !broadParents.has(parent) &&
        safeSystemPath(parent)
          ? parent
          : repository;
      // The launch root is explicit in both modes; only native launch may expose its safe parent.
      if (safeSystemPath(initial)) configured.unshift(initial);
    }
    const roots: RootRecord[] = [];
    const exclusions = options.excludedPaths ?? [];
    for (const source of configured) {
      try {
        const requested = resolve(source);
        const path = await realpath(requested);
        if (
          !safeSystemPath(path) ||
          exclusions.some((excluded) => inside(excluded, path))
        )
          throw new Error(
            "Choose a project folder outside system folders and review state",
          );
        const identity = await lstat(path);
        if (!identity.isDirectory() || !readable(identity))
          throw new Error("Folder must be a readable directory");
        await access(path, constants.R_OK | constants.X_OK);
        const existing = roots.find((root) => root.path === path);
        if (existing) existing.configuredPaths.push(requested);
        else
          roots.push({
            id: randomUUID(),
            label: basename(path) || path,
            path,
            configuredPaths: [requested],
            identity,
          });
      } catch (error) {
        throw new Error(
          `Unable to configure --browse-root ${source}: ${(error as Error).message}`,
        );
      }
    }
    return new DirectoryBrowser(roots, exclusions, options.container ?? false);
  }
  private excluded(path: string) {
    return this.exclusions.some((root) => inside(root, path));
  }
  private async validateRoot(root: RootRecord) {
    try {
      for (const configured of root.configuredPaths)
        if ((await realpath(configured)) !== root.path)
          throw new Error("changed");
      const stats = await lstat(root.path);
      if (stats.isSymbolicLink() || !sameIdentity(root.identity, stats))
        throw new Error("changed");
      if (!readable(stats))
        throw new DirectoryBrowseError(
          403,
          "Folder cannot be read. Check the server's folder permissions.",
        );
      await access(root.path, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof DirectoryBrowseError) throw error;
      throw new DirectoryBrowseError(
        403,
        "Configured folder changed or is unavailable. Restart the server to confirm its --browse-root.",
      );
    }
  }
  get nativePickerAvailable() {
    return platform() === "darwin" && !this.container;
  }
  async listRoots(): Promise<DirectoryRootsResponse> {
    if (this.nativePickerAvailable)
      return { roots: [], nativePickerAvailable: true };
    const roots: DirectoryRoot[] = [];
    for (const root of this.roots) {
      await this.validateRoot(root);
      roots.push({ id: root.id, label: root.label, path: root.path });
    }
    return {
      roots,
      nativePickerAvailable: false,
      ...(!roots.length
        ? {
            message: this.container
              ? "No folders are configured for browsing. Mount the project folder in Docker and launch with --browse-root followed by that mounted path."
              : "No folders are configured for browsing. Launch with a repository path or add --browse-root followed by a project folder path.",
          }
        : {}),
    };
  }
  private async validateDirectory(root: RootRecord, relativePath: string) {
    await this.validateRoot(root);
    let path = root.path;
    for (const part of relativePath ? relativePath.split("/") : []) {
      path = join(path, part);
      if (!inside(root.path, path) || this.excluded(path))
        throw new DirectoryBrowseError(
          403,
          "Folder is outside the configured browsing area.",
        );
      const stats = await lstat(path);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(path)) !== path
      )
        throw new DirectoryBrowseError(
          403,
          "Only real folders within the configured browsing area can be opened. Symbolic links are excluded.",
        );
      if (!readable(stats))
        throw new DirectoryBrowseError(
          403,
          "Folder cannot be read. Check the server's folder permissions.",
        );
      await access(path, constants.R_OK | constants.X_OK);
    }
    return { path, identity: await lstat(path) };
  }
  async list(
    rootId: string,
    relativePath = "",
    cursor = "0",
  ): Promise<DirectoryListing> {
    if (
      relativePath.length > 4096 ||
      isAbsolute(relativePath) ||
      (relativePath !== "" &&
        (relativePath.split("/").length > 64 ||
          relativePath
            .split("/")
            .some((part) => !visible(part) || part.length > 255)))
    )
      throw new DirectoryBrowseError(
        400,
        "Choose a folder within a configured browsing root.",
      );
    if (
      !/^(0|[1-9]\d*)$/.test(cursor) ||
      Number(cursor) > SCAN_LIMIT ||
      Number(cursor) % PAGE_SIZE !== 0
    )
      throw new DirectoryBrowseError(
        400,
        "Invalid folder page. Reopen this folder to start again.",
      );
    const root = this.roots.find((root) => root.id === rootId);
    if (!root)
      throw new DirectoryBrowseError(
        404,
        "Browsing root is not configured. Reopen the folder chooser.",
      );
    try {
      const directory = await this.validateDirectory(root, relativePath);
      const entries: DirectoryEntry[] = [];
      let scanned = 0;
      let truncated = false;
      const { pinned, handle, descriptorPath } = await openPinnedDirectory(
        directory.path,
        directory.identity,
      );
      try {
        while (true) {
          const entry = await handle.read();
          if (!entry) break;
          if (++scanned > SCAN_LIMIT) {
            truncated = true;
            break;
          }
          if (
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            !visible(entry.name)
          )
            continue;
          const childPath = join(directory.path, entry.name);
          if (this.excluded(childPath)) continue;
          try {
            const anchoredChildPath = join(descriptorPath, entry.name);
            const stats = await lstat(anchoredChildPath);
            if (
              !stats.isDirectory() ||
              stats.isSymbolicLink() ||
              !readable(stats) ||
              (await realpath(anchoredChildPath)) !== childPath
            )
              continue;
            await access(anchoredChildPath, constants.R_OK | constants.X_OK);
            entries.push({
              name: entry.name,
              relativePath: relativePath
                ? `${relativePath}/${entry.name}`
                : entry.name,
            });
          } catch {
            /* Inaccessible or concurrently removed children are omitted. */
          }
        }
      } finally {
        try {
          await handle.close();
        } finally {
          await pinned?.close();
        }
      }
      // Discard the entire result if a root/ancestor changed while enumerating.
      const after = await this.validateDirectory(root, relativePath);
      if (!sameIdentity(directory.identity, after.identity))
        throw new DirectoryBrowseError(
          403,
          "Folder changed while browsing. Go back and reopen it.",
        );
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const offset = Number(cursor);
      return {
        rootId,
        relativePath,
        path: directory.path,
        entries: entries.slice(offset, offset + PAGE_SIZE),
        nextCursor:
          offset + PAGE_SIZE < entries.length
            ? String(offset + PAGE_SIZE)
            : null,
        truncated,
        ...(truncated
          ? {
              message: `This folder exceeds the ${SCAN_LIMIT}-entry browsing limit. Some folders are omitted; launch with a narrower --browse-root to reach them.`,
            }
          : {}),
      };
    } catch (error) {
      throw pathError(error);
    }
  }
}

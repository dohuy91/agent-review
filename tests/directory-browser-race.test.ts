import { afterEach, expect, test, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectoryBrowser } from "../apps/server/src/directory-browser.js";

const hooks = vi.hoisted(() => ({
  afterOpen: null as null | (() => Promise<void>),
  opened: [] as FileHandle[],
  flags: [] as number[],
  directoryPaths: [] as string[],
  childMetadataPaths: [] as string[],
  wrongPinnedIdentity: false,
  wrongDescriptorIdentity: false,
  descriptorUnavailable: false,
  descendantLookupUnavailable: false,
  enumerationUnavailable: false,
  readFailure: false,
  closedDirectories: 0,
}));
vi.mock("node:fs/promises", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const result = await fs.open(...args);
      hooks.opened.push(result);
      hooks.flags.push(Number(args[1]));
      const originalStat = result.stat.bind(result);
      result.stat = (async (...statArgs: Parameters<typeof result.stat>) => {
        const value = await originalStat(...statArgs);
        return hooks.wrongPinnedIdentity
          ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
              ino: Number(value.ino) + 1,
            })
          : value;
      }) as typeof result.stat;
      return result;
    },
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (/^\/(proc\/self|dev)\/fd\//.test(String(args[0]))) {
        if (
          hooks.descriptorUnavailable ||
          (hooks.descendantLookupUnavailable && String(args[0]).endsWith("/."))
        )
          throw Object.assign(
            new Error("Synthetic descriptor filesystem unavailable"),
            { code: "ENOENT" },
          );
        // Reach the synthetic unavailable-descendant check even on Darwin,
        // whose real /dev/fd alias can fail the earlier identity comparison.
        if (
          process.platform === "darwin" &&
          hooks.descendantLookupUnavailable &&
          !String(args[0]).endsWith("/.")
        )
          return hooks.opened[hooks.opened.length - 1]!.stat();
        const value = await fs.stat(...args);
        return hooks.wrongDescriptorIdentity
          ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
              ino: Number(value.ino) + 1,
            })
          : value;
      }
      return fs.stat(...args);
    },
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      if (/^\/(proc\/self|dev)\/fd\/\d+\//.test(String(args[0])))
        hooks.childMetadataPaths.push(String(args[0]));
      return fs.lstat(...args);
    },
    opendir: async (...args: Parameters<typeof fs.opendir>) => {
      hooks.directoryPaths.push(String(args[0]));
      if (hooks.enumerationUnavailable)
        throw Object.assign(
          new Error("Synthetic descriptor enumeration unavailable"),
          { code: "ENOTSUP" },
        );
      const result = await fs.opendir(...args);
      const originalClose = result.close.bind(result);
      result.close = (async () => {
        hooks.closedDirectories++;
        return originalClose();
      }) as typeof result.close;
      const originalRead = result.read.bind(result);
      result.read = (async () => {
        if (hooks.readFailure)
          throw new Error("Synthetic directory read failure");
        return originalRead();
      }) as typeof result.read;
      const callback = hooks.afterOpen;
      hooks.afterOpen = null;
      if (callback) await callback();
      return result;
    },
  };
});
// These integration cases require real descriptor-anchored descendant enumeration.
const descriptorTest = test.skipIf(process.platform !== "linux");
const fixtures: string[] = [];
afterEach(async () => {
  hooks.afterOpen = null;
  for (const handle of hooks.opened) if (handle.fd !== -1) await handle.close();
  hooks.opened = [];
  hooks.flags = [];
  hooks.directoryPaths = [];
  hooks.childMetadataPaths = [];
  hooks.wrongPinnedIdentity = false;
  hooks.wrongDescriptorIdentity = false;
  hooks.descriptorUnavailable = false;
  hooks.descendantLookupUnavailable = false;
  hooks.enumerationUnavailable = false;
  hooks.readFailure = false;
  hooks.closedDirectories = 0;
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "directory-race-"));
  fixtures.push(root);
  return realpath(root);
}
descriptorTest(
  "root replacement during enumeration discards directory names instead of serving a partial page",
  async () => {
    const parent = await fixture(),
      root = join(parent, "root"),
      old = join(parent, "old"),
      outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(join(root, "original"));
    await mkdir(outside);
    await mkdir(join(outside, "private"));
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks.afterOpen = async () => {
      await rename(root, old);
      await symlink(outside, root, "dir");
    };
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 403,
    });
  },
);
descriptorTest(
  "a replaced nested directory is rejected after enumeration",
  async () => {
    const root = await fixture(),
      nested = join(root, "nested");
    await mkdir(nested);
    await mkdir(join(nested, "before"));
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks.afterOpen = async () => {
      await rename(nested, join(root, "old"));
      await mkdir(nested);
      await mkdir(join(nested, "replacement"));
    };
    await expect(browser.list(roots[0]!.id, "nested")).rejects.toMatchObject({
      statusCode: 403,
    });
  },
);

descriptorTest(
  "enumeration and child metadata use the validated directory descriptor and release handles",
  async () => {
    const root = await fixture();
    await mkdir(join(root, "child"));
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    expect((await browser.list(roots[0]!.id)).entries).toEqual([
      { name: "child", relativePath: "child" },
    ]);
    expect(hooks.flags).toHaveLength(1);
    expect(hooks.flags[0]! & constants.O_NOFOLLOW).not.toBe(0);
    expect(hooks.flags[0]! & constants.O_DIRECTORY).not.toBe(0);
    expect(hooks.directoryPaths).toHaveLength(1);
    expect(hooks.directoryPaths[0]).toMatch(/^\/(proc\/self|dev)\/fd\/\d+$/);
    expect(hooks.childMetadataPaths).toContain(
      `${hooks.directoryPaths[0]}/child`,
    );
    expect(hooks.opened.every((handle) => handle.fd === -1)).toBe(true);
    expect(hooks.closedDirectories).toBe(1);
  },
);

test.each(["wrongPinnedIdentity", "wrongDescriptorIdentity"] as const)(
  "%s rejects before reading any directory entries and releases the pinned handle",
  async (failure) => {
    const root = await fixture();
    await mkdir(join(root, "child"));
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks[failure] = true;
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(hooks.directoryPaths).toHaveLength(0);
    expect(hooks.opened).toHaveLength(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
  },
);

test.each(["descriptorUnavailable", "descendantLookupUnavailable"] as const)(
  "%s fails closed without pathname fallback and releases handles",
  async (failure) => {
    const root = await fixture();
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks[failure] = true;
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(
      hooks.directoryPaths.every((path) =>
        /^\/(proc\/self|dev)\/fd\/\d+$/.test(path),
      ),
    ).toBe(true);
    expect(hooks.directoryPaths).not.toContain(root);
    expect(hooks.opened).toHaveLength(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
  },
);

descriptorTest.each(["enumerationUnavailable"] as const)(
  "%s fails closed without pathname fallback and releases handles",
  async (failure) => {
    const root = await fixture();
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks[failure] = true;
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(
      hooks.directoryPaths.every((path) =>
        /^\/(proc\/self|dev)\/fd\/\d+$/.test(path),
      ),
    ).toBe(true);
    expect(hooks.directoryPaths).not.toContain(root);
    expect(hooks.opened).toHaveLength(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
  },
);

descriptorTest(
  "read failure closes both directory and pinned handles",
  async () => {
    const root = await fixture();
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks.readFailure = true;
    await expect(browser.list(roots[0]!.id)).rejects.toBeInstanceOf(Error);
    expect(hooks.closedDirectories).toBe(1);
    expect(hooks.opened).toHaveLength(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
  },
);

descriptorTest(
  "descriptor identity is checked again after opening enumeration and both handles close on failure",
  async () => {
    const root = await fixture();
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    hooks.afterOpen = async () => {
      hooks.wrongDescriptorIdentity = true;
    };
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(hooks.closedDirectories).toBe(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
  },
);

test.skipIf(process.platform !== "darwin")(
  "Darwin descriptor identity mismatch releases the pinned handle before enumeration",
  async () => {
    const root = await fixture();
    await mkdir(join(root, "private-child-name"));
    const browser = await DirectoryBrowser.create({
      browseRoots: [root],
      container: true,
    });
    const { roots } = await browser.listRoots();
    await expect(browser.list(roots[0]!.id)).rejects.toMatchObject({
      statusCode: 403,
      message:
        "Open directory identity could not be verified. Folder browsing was stopped.",
    });
    expect(hooks.opened).toHaveLength(1);
    expect(hooks.opened[0]!.fd).toBe(-1);
    expect(hooks.directoryPaths).toEqual([]);
    expect(hooks.childMetadataPaths).toEqual([]);
    expect(hooks.closedDirectories).toBe(0);
  },
);

import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, ExecFileException } from "node:child_process";
import {
  NativeDirectoryPicker,
  type NativePickerProcess,
} from "../apps/server/src/native-directory-picker.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-picker-")));
  fixtures.push(path);
  return path;
}
function runner() {
  let complete!: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void;
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn(() => true);
  const run = vi.fn<NativePickerProcess>((_file, _args, _options, callback) => {
    complete = callback;
    return child;
  });
  return {
    run,
    child,
    finish: (
      stdout = "",
      stderr = "",
      error: ExecFileException | null = null,
    ) => complete(error, stdout, stderr),
  };
}
test("native chooser uses a fixed AppleScript command with bounded output and time, then returns the chosen canonical directory", async () => {
  const root = await fixture(),
    chosen = join(root, "project with spaces");
  await mkdir(chosen);
  const process = runner(),
    picker = new NativeDirectoryPicker(process.run);
  const result = picker.choose();
  expect(process.run).toHaveBeenCalledOnce();
  const [file, args, options] = process.run.mock.calls[0]!;
  expect(file).toBe("/usr/bin/osascript");
  expect(args[0]).toBe("-e");
  expect(args).toHaveLength(2);
  expect(args[1]).toContain("choose folder");
  expect(args[1]).toContain("POSIX path");
  expect(args[1]).toContain("-128");
  expect(args[1]).not.toContain(chosen);
  expect(options).toMatchObject({
    shell: false,
    timeout: 120000,
    maxBuffer: 16384,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  process.finish(chosen + "/\n");
  expect(await result).toEqual({ path: chosen });
});
test("only one native chooser may run at a time and user cancellation selects nothing", async () => {
  const process = runner(),
    picker = new NativeDirectoryPicker(process.run);
  const first = picker.choose();
  await expect(picker.choose()).rejects.toMatchObject({ statusCode: 429 });
  expect(process.run).toHaveBeenCalledOnce();
  process.finish("\n");
  expect(await first).toEqual({ path: null });
  const second = picker.choose();
  process.finish(
    "",
    "execution error: User canceled. (-128)",
    Object.assign(new Error("cancel"), { code: 1 }),
  );
  expect(await second).toEqual({ path: null });
  expect(process.run).toHaveBeenCalledTimes(2);
});
test.each([
  ["timeout", { killed: true, signal: "SIGKILL", code: null }, "", 504],
  ["output cap", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "", 502],
  ["permission", { code: 1 }, "not authorized (-1743)", 403],
  ["missing executable", { code: "ENOENT" }, "", 503],
] as const)(
  "%s returns an actionable bounded error",
  async (_name, details, stderr, statusCode) => {
    const process = runner(),
      picker = new NativeDirectoryPicker(process.run);
    const result = picker.choose();
    process.finish(
      "",
      stderr,
      Object.assign(
        new Error("private diagnostic"),
        details,
      ) as ExecFileException,
    );
    await expect(result).rejects.toMatchObject({ statusCode });
    await expect(result).rejects.not.toThrow("private diagnostic");
  },
);
test("canceling the owned dialog terminates its process and ignores any eventual selection", async () => {
  const root = await fixture(),
    process = runner(),
    picker = new NativeDirectoryPicker(process.run);
  const result = picker.choose();
  picker.cancel();
  expect(process.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  process.finish(root + "\n");
  expect(await result).toEqual({ path: null });
});
test.each(["relative/path\n", "/a\n/b\n", "/a\u0000b\n"])(
  "invalid returned path is never accepted: %j",
  async (stdout) => {
    const process = runner(),
      picker = new NativeDirectoryPicker(process.run),
      result = picker.choose();
    process.finish(stdout);
    await expect(result).rejects.toMatchObject({ statusCode: 502 });
  },
);

test("a delayed cancellation cannot close a newer owned dialog", async () => {
  const process = runner(),
    picker = new NativeDirectoryPicker(process.run);
  const first = picker.choose("first");
  process.finish("\n");
  await first;
  const next = picker.choose("second");
  picker.cancel("first");
  expect(process.child.kill).not.toHaveBeenCalled();
  picker.cancel("second");
  expect(process.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  process.finish("\n");
  expect(await next).toEqual({ path: null });
});
test("a synchronous process-start failure releases the single-dialog lock", async () => {
  const run = vi.fn<NativePickerProcess>(() => {
      throw new Error("spawn fixture failure");
    }),
    picker = new NativeDirectoryPicker(run);
  await expect(picker.choose()).rejects.toMatchObject({ statusCode: 503 });
  await expect(picker.choose()).rejects.toMatchObject({ statusCode: 503 });
  expect(run).toHaveBeenCalledTimes(2);
});

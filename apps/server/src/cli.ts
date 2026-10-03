import { writeFile } from "node:fs/promises";
import { ReviewStore } from "../../../packages/review/src/store.js";
import type { ReviewMode } from "../../../packages/shared/src/index.js";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createApp } from "./app.js";
const usage =
  "Usage: review-app <path> [--base <ref>] [--mode branch|working|staged|full] [--port <number>] [--no-open] [--container] [--enable-writes] [--skills-dir <path>] [--browse-root <path>] | <path> --export-comments <new-output.json>";
import { agentDefaults } from "../../../packages/agents/src/defaults.js";
export function parseCLI(args: string[]) {
  let path: string | undefined;
  let port = 7373;
  let base: string | undefined;
  let mode: ReviewMode = "full";
  let modeSpecified = false;
  let exportPath: string | undefined;
  let open = true;
  let host = "127.0.0.1";
  let launchOption = false;
  const skillRoots: string[] = [];
  const browseRoots: string[] = [];
  let enableWrites = false;
  let container = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--enable-writes") {
      enableWrites = true;
      launchOption = true;
    } else if (arg === "--browse-root") {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error("--browse-root requires a value");
      browseRoots.push(resolve(value));
      launchOption = true;
    } else if (arg === "--skills-dir") {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error("--skills-dir requires a value");
      skillRoots.push(resolve(value));
      launchOption = true;
    } else if (arg === "--container") {
      container = true;
      host = "0.0.0.0";
      open = false;
      launchOption = true;
    } else if (arg === "--no-open") {
      open = false;
      launchOption = true;
    } else if (
      ["--port", "--base", "--mode", "--export-comments"].includes(arg)
    ) {
      const value = args[++i];
      if (!value || value.startsWith("-"))
        throw new Error(`${arg} requires a value`);
      if (arg !== "--export-comments") launchOption = true;
      if (arg === "--port") {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
          throw new Error("Port must be an integer from 1 to 65535");
        port = Number(value);
      } else if (arg === "--base") base = value;
      else if (arg === "--export-comments") exportPath = value;
      else {
        if (!["branch", "working", "staged", "full"].includes(value))
          throw new Error("Invalid review mode");
        mode = value as ReviewMode;
        modeSpecified = true;
      }
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (path) throw new Error("Provide exactly one repository path");
    else path = arg;
  }
  if (!path) throw new Error(usage);
  if (exportPath && launchOption)
    throw new Error(
      "--base, --mode, --port, --container and --no-open apply only to launch; export uses the latest saved comment context (or HEAD/full when empty)",
    );
  const defaults = agentDefaults(container);
  return {
    path,
    port,
    base,
    mode,
    modeSpecified,
    open,
    exportPath,
    host,
    container,
    browseRoots,
    skillRoots: [...defaults.skillRoots, ...skillRoots],
    enableWrites: defaults.enableWrites || enableWrites,
  };
}
async function exportComments(path: string, output: string, dataDir: string) {
  const token = randomBytes(32).toString("hex");
  const app = await createApp({
    port: 7373,
    token,
    dataDir,
    repositoryPath: path,
  });
  try {
    // Reuse authenticated, validated routes without binding a socket.
    const headers = { host: "localhost:7373", origin: "http://localhost:7373" };
    const session = await app.inject({
      method: "POST",
      url: "/api/session",
      headers,
      payload: { token },
    });
    const cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    const authenticated = { ...headers, cookie };
    const repos = (
      await app.inject({ url: "/api/repositories", headers: authenticated })
    ).json();
    const id = repos.selectedRepositoryId;
    const store = new ReviewStore(dataDir);
    let context;
    try {
      context = store.list(id).at(-1);
    } finally {
      store.close();
    }
    const base = context?.base ?? "HEAD";
    const mode = context?.mode ?? "full";
    const review = await app.inject({
      url: `/api/repositories/${id}/review?base=${encodeURIComponent(base)}&mode=${mode}`,
      headers: authenticated,
    });
    if (review.statusCode !== 200)
      throw new Error(
        "Saved review base is no longer available; restore the base ref before exporting",
      );
    const result = await app.inject({
      url: `/api/repositories/${id}/export?reviewId=${review.json().id}`,
      headers: authenticated,
    });
    if (result.statusCode !== 200)
      throw new Error(
        "Repository changed during export; retry with a stable worktree",
      );
    await writeFile(
      resolve(output),
      JSON.stringify(result.json(), null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(`Exported comments to ${resolve(output)}\n`);
  } finally {
    await app.close();
  }
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage + "\n");
    return;
  }
  const options = parseCLI(args);
  const dataDir =
    process.env.REVIEW_DATA_DIR ??
    join(homedir(), ".local", "share", "agent-review");
  if (options.exportPath)
    return exportComments(options.path, options.exportPath, dataDir);
  const token = randomBytes(32).toString("hex");
  const app = await createApp({
    container: options.container,
    browseRoots: options.browseRoots,
    skillRoots: options.skillRoots,
    enableWrites: options.enableWrites,
    port: options.port,
    token,
    dataDir,
    ...(options.modeSpecified ? { mode: options.mode } : {}),
    repositoryPath: options.path,
    ...(options.base ? { base: options.base } : {}),
  });
  try {
    await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  const url = `http://127.0.0.1:${options.port}/#token=${token}`;
  process.stdout.write(`Agent Review: ${url}\n`);
  if (options.open) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    const child = spawn(command, [url], { stdio: "ignore" });
    child.on("error", () =>
      process.stderr.write(
        "Could not open browser; use the launch URL above.\n",
      ),
    );
    child.unref();
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    process.stderr.write(`Unable to launch: ${error.message}\n`);
    process.exitCode = 1;
  });

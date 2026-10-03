import {
  unknownCodexProvider,
  type AgentAvailability,
} from "../../shared/src/index.js";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
export type ProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export const nativeProcessFactory: ProcessFactory = (command, args, options) =>
  spawn(command, args, { ...options, stdio: "pipe" });
export async function codexAvailability(): Promise<AgentAvailability> {
  const probe = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const p = spawn("codex", args, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let output = "";
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        reject(new Error("Probe timeout"));
      }, 5000);
      p.stdout.on("data", (b: Buffer) => {
        if (output.length + b.length > 65536) {
          p.kill("SIGKILL");
          reject(new Error("Probe limit"));
        } else output += b.toString();
      });
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(output) : reject(new Error("Probe failed"));
      });
    });
  try {
    const version = await probe(["--version"]);
    const help = await probe(["exec", "--help"]);
    const supported =
      ["--ephemeral", "--sandbox", "--json", "--color", "--cd"].every((s) =>
        help.includes(s),
      ) && help.includes("stdin");
    return {
      id: "codex",
      provider: unknownCodexProvider,
      available: supported,
      version: version.trim().slice(0, 100),
      error: supported ? null : "Unsupported Codex CLI",
    };
  } catch {
    return {
      id: "codex",
      provider: unknownCodexProvider,
      available: false,
      version: null,
      error: "Codex CLI unavailable",
    };
  }
}
export function startCodex(
  factory: ProcessFactory,
  cwd: string,
  prompt: string,
) {
  const child = factory(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--sandbox",
      "workspace-write",
      "--json",
      "--color",
      "never",
      "--cd",
      cwd,
      "-",
    ],
    { cwd, shell: false, detached: process.platform !== "win32" },
  );
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  return child;
}

export const MAX_ARGV_PROMPT_BYTES = 64 * 1024;
export function startAdapter(
  adapter: import("../../shared/src/index.js").AgentAdapter,
  factory: ProcessFactory,
  cwd: string,
  prompt: string,
) {
  if (adapter === "codex") return startCodex(factory, cwd, prompt);
  if (
    adapter === "opencode" &&
    Buffer.byteLength(prompt, "utf8") > MAX_ARGV_PROMPT_BYTES
  )
    throw Object.assign(new Error("OpenCode prompt exceeds 64KiB argv limit"), {
      statusCode: 413,
    });
  const args =
    adapter === "claude"
      ? [
          "-p",
          "--input-format",
          "text",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--no-session-persistence",
          "--permission-mode",
          "manual",
          "--permission-prompts",
          "none",
        ]
      : ["run", "--format", "json", "--dir", cwd, "--", prompt];
  const child = factory(adapter, args, {
    cwd,
    shell: false,
    detached: process.platform !== "win32",
  });
  child.stdin.on("error", () => {});
  child.stdin.end(adapter === "claude" ? prompt : undefined);
  return child;
}
export async function adapterAvailability(
  id: "claude" | "opencode",
): Promise<AgentAvailability> {
  const probe = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(id, args, {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let text = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("timeout"));
      }, 5000);
      child.stdout.on("data", (b: Buffer) => {
        if (Buffer.byteLength(text) + b.length > 65536) {
          child.kill("SIGKILL");
          reject(new Error("limit"));
        } else text += b.toString();
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve(text) : reject(new Error("probe failed"));
      });
    });
  const provider = {
    identity: null,
    label: `Provider identity unknown; uses local ${id} CLI settings`,
  };
  try {
    const version = await probe(["--version"]);
    const help = await probe(id === "claude" ? ["--help"] : ["run", "--help"]);
    const flags =
      id === "claude"
        ? [
            "--input-format",
            "--output-format",
            "--permission-mode",
            "--permission-prompts",
            "--no-session-persistence",
          ]
        : ["--format", "--dir"];
    const available = flags.every((f) => help.includes(f));
    return {
      id,
      provider,
      available,
      version: version.trim().slice(0, 100),
      error: available ? null : `Unsupported ${id} CLI`,
    };
  } catch {
    return {
      id,
      provider,
      available: false,
      version: null,
      error: `${id} CLI unavailable`,
    };
  }
}

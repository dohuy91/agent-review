import { spawn } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import type { Repository, GitRemote } from "../../shared/src/index.js";
import { git, gitText } from "./git.js";
import {
  GitActionError,
  validateIdentity,
  validateWriteDestinations,
} from "./mutations.js";
import { StaleReviewError } from "./review.js";
export type FetchTransport = (
  command: "git",
  args: string[],
  options: ExecFileOptions,
) => Promise<void>;
export const nativeFetchTransport: FetchTransport = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let failed = false,
      bytes = 0,
      settled = false;
    let escalation: NodeJS.Timeout | undefined;
    const signal = (value: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, value);
        else child.kill(value);
      } catch {}
    };
    const stop = () => {
      if (failed) return;
      failed = true;
      signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 100);
    };
    const timer = setTimeout(stop, options.timeout ?? 60000);
    const output = (data: Buffer) => {
      bytes += data.length;
      if (bytes > (options.maxBuffer ?? 1024 * 1024)) stop();
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    const finish = (error: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
        signal("SIGKILL");
      }
      if (error || failed) reject(new Error("Fetch failed"));
      else resolve();
    };
    child.on("error", () => finish(true));
    child.on("close", (code) => finish(code !== 0));
  });
async function configuration(repo: Repository) {
  const bytes = await git(repo.root, ["config", "--null", "--list"]);
  const values = new Map<string, string[]>();
  for (const entry of bytes.toString("utf8").split("\0").filter(Boolean)) {
    const split = entry.indexOf("\n");
    const key = split < 0 ? entry : entry.slice(0, split);
    const value = split < 0 ? "" : entry.slice(split + 1);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  return { bytes, values };
}
function describe(url: string): Pick<GitRemote, "transport" | "url"> {
  if (!url || /[\x00-\x20\x7f]/.test(url))
    return { transport: "unsupported", url: "Unsupported remote URL" };
  try {
    if (url.startsWith("https://") || url.startsWith("ssh://")) {
      const parsed = new URL(url);
      if (!parsed.hostname || parsed.hostname.startsWith("-"))
        throw new Error();
      const transport = parsed.protocol === "https:" ? "https" : "ssh";
      if (
        transport === "ssh" &&
        (parsed.password ||
          (parsed.username && !/^[a-zA-Z0-9_.-]+$/.test(parsed.username)))
      )
        throw new Error();
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return { transport, url: parsed.toString() };
    }
    const scp =
      /^(?:([a-zA-Z0-9_.-]+)@)?([a-zA-Z0-9][a-zA-Z0-9.-]*):([^\s]+)$/.exec(url);
    if (
      scp &&
      !scp[3]!.startsWith(":") &&
      !scp[3]!.startsWith("-") &&
      !url.includes("://")
    )
      return { transport: "ssh", url: `${scp[2]}:${scp[3]!.split(/[?#]/)[0]}` };
  } catch {}
  return { transport: "unsupported", url: "Unsupported remote URL" };
}
async function resolveRemote(
  repo: Repository,
  name: string,
  config: Awaited<ReturnType<typeof configuration>>,
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
    throw new GitActionError(
      "Remote name is unsupported; configure a simple named HTTPS or SSH remote",
    );
  const values = config.values;
  const urls = values.get(`remote.${name}.url`) ?? [];
  if (urls.length !== 1)
    throw new GitActionError(
      "Configure one explicit HTTPS or SSH URL for this remote",
    );
  const effective = (
    await gitText(repo.root, ["remote", "get-url", "--all", name])
  ).split("\n");
  if (effective.length !== 1)
    throw new GitActionError(
      "Configure one explicit HTTPS or SSH URL for this remote",
    );
  const metadata = describe(effective[0]!);
  let reason: string | null = null;
  if (metadata.transport === "unsupported")
    reason =
      "Only effective HTTPS and SSH remote URLs support Fetch; check URL rewrites";
  if (
    values.has(`remotes.${name}`) ||
    values.has(`remote.${name}.uploadpack`) ||
    values.has(`remote.${name}.vcs`) ||
    values.has(`remote.${name}.serveroption`)
  )
    reason =
      "Remote groups, custom upload-pack, and remote helpers are unsupported; use a standard named remote";
  if (values.has("core.alternaterefscommand"))
    reason =
      "Configured alternate reference commands are unsupported for Fetch; remove this non-authentication command before retrying";
  try {
    await validateWriteDestinations(repo, { objects: true, remote: name });
  } catch (error) {
    if (error instanceof GitActionError) reason = error.message;
    else throw error;
  }
  const refspecs = values.get(`remote.${name}.fetch`) ?? [];
  const scope = `refs/remotes/${name}/`;
  if (
    !refspecs.length ||
    refspecs.some((spec) => {
      const match =
        /^\+?(refs\/heads\/(?:\*|[A-Za-z0-9_./-]+)):(refs\/remotes\/[A-Za-z0-9_./*-]+)$/.exec(
          spec,
        );
      return (
        !match ||
        !match[2]!.startsWith(scope) ||
        match[2]!.includes("..") ||
        match[2]!.endsWith("/") ||
        match[1]!.includes("*") !== match[2]!.includes("*")
      );
    })
  )
    reason =
      "Fetch refspecs must target only this remote’s tracking references; local branch updates are unsupported";
  const symbolic = (
    await gitText(repo.root, ["for-each-ref", "--format=%(symref)", scope])
  )
    .split("\n")
    .filter(Boolean);
  if (symbolic.some((ref) => !ref.startsWith(scope)))
    reason =
      "Remote-tracking references point outside this remote; repair them with Git before Fetch";
  return { name, ...metadata, fetchAvailable: reason === null, reason };
}
export async function getRemotes(repo: Repository): Promise<GitRemote[]> {
  await validateIdentity(repo);
  const config = await configuration(repo);
  const names = [
    ...new Set(
      [...config.values.keys()]
        .map((key) => /^remote\.(.+)\.url$/.exec(key)?.[1])
        .filter((n): n is string => !!n),
    ),
  ].sort();
  const result: GitRemote[] = [];
  for (const name of names) {
    try {
      result.push(await resolveRemote(repo, name, config));
    } catch {
      result.push({
        name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)
          ? name
          : "Unsupported remote name",
        url: "Unsupported remote URL",
        transport: "unsupported",
        fetchAvailable: false,
        reason: "Configure one standard named HTTPS or SSH remote",
      });
    }
  }
  return result;
}
export async function fetchRemote(
  repo: Repository,
  name: string,
  expectedHead: string,
  transport: FetchTransport = nativeFetchTransport,
) {
  const identity = await validateIdentity(repo);
  if (identity.head !== expectedHead) throw new StaleReviewError();
  const config = await configuration(repo);
  const remote = await resolveRemote(repo, name, config);
  if (!remote.fetchAvailable) throw new GitActionError(remote.reason!);
  // Never accept URL/refspec/environment from HTTP. Existing credential/SSH machinery is
  // inherited only here, after explicit Fetch, while repository-routing Git variables are removed.
  const allowed = new Set([
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_ASKPASS",
  ]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") || allowed.has(key),
    ),
  );
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  });
  const args = [
    "--no-pager",
    "--no-replace-objects",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "-c",
    "protocol.ssh.allow=always",
    "-c",
    "fetch.writeCommitGraph=false",
    "-c",
    "http.followRedirects=false",
    "-C",
    repo.root,
    "fetch",
    "--no-all",
    "--no-tags",
    "--no-prune",
    "--no-prune-tags",
    "--no-recurse-submodules",
    "--no-auto-maintenance",
    "--no-write-commit-graph",
    "--no-write-fetch-head",
    "--no-progress",
    "--upload-pack=git-upload-pack",
    "--refmap=",
    "--",
    name,
    `refs/heads/*:refs/remotes/${name}/*`,
  ];
  await validateIdentity(repo, identity);
  if (!(await configuration(repo)).bytes.equals(config.bytes))
    throw new StaleReviewError();
  await validateWriteDestinations(repo, { objects: true, remote: name });
  try {
    await transport("git", args, {
      shell: false,
      env,
      encoding: "buffer",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new GitActionError(
      "Fetch failed or timed out; check existing local authentication and remote access in Git",
      502,
    );
  }
  await validateIdentity(repo, identity);
  return { ok: true as const, remote: name };
}

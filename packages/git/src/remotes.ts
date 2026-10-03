import { spawn } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import type { Repository, GitRemote } from "../../shared/src/index.js";
import { git, gitText } from "./git.js";
import {
  GitActionError,
  RepositoryQueue,
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
  const worktreeRemotes = new Set<string>();
  if (
    (values.get("extensions.worktreeconfig") ?? []).some((value) =>
      /^(true|yes|on|1)$/i.test(value),
    )
  ) {
    const scoped = await git(repo.root, [
      "config",
      "--worktree",
      "--null",
      "--list",
    ]);
    for (const entry of scoped.toString("utf8").split("\0").filter(Boolean)) {
      const key = entry.slice(0, entry.indexOf("\n"));
      const name = /^remote\.(.+)\.[^.]+$/.exec(key)?.[1];
      if (name) worktreeRemotes.add(name);
    }
  }
  return { bytes, values, worktreeRemotes };
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
// Reused by explicit Push without broadening the Fetch transport or configuration boundary.
export {
  configuration as readRemoteConfiguration,
  describe as describeRemoteUrl,
};
// Git's URL-scoped HTTP policy takes precedence over -c http.followRedirects=false.
// Refuse every non-false scoped override instead of passing a configured redirect policy
// to a recipient that the user has approved. Config values and URLs stay out of errors.
export function hasUnsafeRedirectOverrides(values: Map<string, string[]>) {
  return [...values].some(
    ([key, configured]) =>
      /^http\..+\.followredirects$/i.test(key) &&
      configured.some((value) => !/^(false|no|off|0)$/i.test(value)),
  );
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
  if (config.worktreeRemotes.has(name))
    reason =
      "Worktree-specific remote configuration is unsupported for project-wide Fetch; configure this remote in the shared Git configuration or use Git directly";
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
  if (hasUnsafeRedirectOverrides(values))
    reason =
      "URL-scoped HTTP redirects are unsupported; configure each redirect override as false before Fetch";
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
const fetchQueue = new RepositoryQueue();
/** Covers legacy explicit Fetch and lifecycle synchronization across linked worktrees. */
export async function fetchRemote(
  repo: Repository,
  name: string,
  expectedHead: string,
  transport: FetchTransport = nativeFetchTransport,
  expectedBranch?: string | null,
  noninteractive = false,
) {
  return fetchQueue.run(repo.commonDir, () =>
    performFetchRemote(
      repo,
      name,
      expectedHead,
      transport,
      expectedBranch,
      noninteractive,
    ),
  );
}
async function performFetchRemote(
  repo: Repository,
  name: string,
  expectedHead: string,
  transport: FetchTransport = nativeFetchTransport,
  expectedBranch?: string | null,
  noninteractive = false,
) {
  const identity = await validateIdentity(repo);
  if (
    identity.head !== expectedHead ||
    (expectedBranch !== undefined && identity.branch !== expectedBranch)
  )
    throw new StaleReviewError();
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
  if (noninteractive) {
    for (const [key, values] of config.values) {
      if (
        /^credential(?:\..+)?\.helper$/i.test(key) &&
        values.some(
          (value) =>
            value &&
            !/^(?:cache(?: --timeout=\d+)?|store(?: --file=[^\s;&|`$<>]+)?|manager|manager-core|osxkeychain|wincred|libsecret)$/.test(
              value,
            ),
        )
      )
        throw new GitActionError(
          "Configured custom credential helpers cannot guarantee noninteractive Fetch; use Git directly or configure a standard credential helper",
        );
      if (
        /^credential\..+\.interactive$/i.test(key) &&
        values.some((value) => !/^(false|no|off|0|never)$/i.test(value))
      )
        throw new GitActionError(
          "URL-scoped interactive credential settings are unsupported for noninteractive Fetch",
        );
    }
    // Automatic synchronization must never open an askpass dialog or interactive SSH prompt.
    env.GIT_ASKPASS = "/bin/false";
    env.SSH_ASKPASS = "/bin/false";
    env.SSH_ASKPASS_REQUIRE = "never";
    env.GCM_INTERACTIVE = "Never";
    env.GCM_GUI_PROMPT = "0";
    let ssh = env.GIT_SSH_COMMAND;
    if (!ssh) {
      try {
        ssh = await gitText(repo.root, ["config", "--get", "core.sshCommand"]);
      } catch (error) {
        if ((error as { code?: number }).code !== 1) throw error;
      }
    }
    const selectedSsh = ssh || env.GIT_SSH || "ssh";
    const sshCommand = /^((?:\/[A-Za-z0-9_.-]+)*\/?ssh)(\s[\s\S]*)?$/.exec(
      selectedSsh,
    );
    if (!sshCommand || /[;&|`$<>\r\n]/.test(selectedSsh))
      throw new GitActionError(
        "Custom SSH commands cannot guarantee noninteractive Fetch; use Git directly or configure standard OpenSSH",
      );
    // OpenSSH uses the first value for an option: put safety before existing overrides.
    env.GIT_SSH_COMMAND = `${sshCommand[1]} -o BatchMode=yes -o StrictHostKeyChecking=yes${sshCommand[2] || ""}`;
    env.GIT_SSH_VARIANT = "ssh";
  }
  const args = [
    ...(noninteractive
      ? [
          "-c",
          "credential.interactive=false",
          "-c",
          "credential.guiPrompt=false",
          "-c",
          "core.askPass=/bin/false",
        ]
      : []),
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
    ...(config.values.get(`remote.${name}.fetch`) ?? []).map((spec) =>
      spec.replace(/^\+/, ""),
    ),
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
  if (!(await configuration(repo)).bytes.equals(config.bytes))
    throw new StaleReviewError();
  return { ok: true as const, remote: name };
}

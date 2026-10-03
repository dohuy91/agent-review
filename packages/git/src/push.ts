import { spawn, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Repository, ReviewObservation } from "../../shared/src/index.js";
import type {
  PushPreview,
  PushPreviewRequest,
  PushRecipient,
  PushResult,
  PushFailureOutcome,
} from "../../shared/src/push.js";
export type {
  PushPreview,
  PushPreviewRequest,
  PushRecipient,
  PushResult,
  PushFailureOutcome,
} from "../../shared/src/push.js";
import { git, gitText } from "./git.js";
import {
  GitActionError,
  RepositoryQueue,
  validateIdentity,
  validateWriteDestinations,
} from "./mutations.js";
import {
  readRemoteConfiguration,
  describeRemoteUrl,
  hasUnsafeRedirectOverrides,
} from "./remotes.js";
import { getComparisonDestinations } from "./comparison-destinations.js";
import { executionStamp } from "../../agents/src/target.js";
import { fingerprint } from "../../review/src/fingerprint.js";

export type PushTransport = (
  command: "git",
  args: string[],
  options: ExecFileOptions,
) => Promise<{ code: number; stdout: Buffer }>;
const OUTPUT_LIMIT = 1024 * 1024,
  TIMEOUT = 60000,
  PLAN_TTL = 5 * 60 * 1000,
  COMMIT_LIMIT = 50;
export class PushError extends GitActionError {
  constructor(
    message: string,
    statusCode = 400,
    public outcome: PushFailureOutcome = "not-pushed",
  ) {
    super(message, statusCode);
  }
}
/** Only bounded stdout protocol data is retained; stderr is counted and discarded. */
export const nativePushTransport: PushTransport = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let failed = false,
      settled = false,
      total = 0;
    const chunks: Buffer[] = [];
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
    const timer = setTimeout(stop, options.timeout ?? TIMEOUT);
    const consume = (chunk: Buffer, stdout: boolean) => {
      total += chunk.length;
      if (total > (options.maxBuffer ?? OUTPUT_LIMIT)) {
        stop();
        return;
      }
      if (stdout && !failed) chunks.push(chunk);
    };
    child.stdout.on("data", (b: Buffer) => consume(b, true));
    child.stderr.on("data", (b: Buffer) => consume(b, false));
    const finish = (code: number, error = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) {
        clearTimeout(escalation);
        signal("SIGKILL");
      }
      if (failed || error) reject(new Error("Git network operation failed"));
      else resolve({ code, stdout: Buffer.concat(chunks) });
    };
    child.on("error", () => finish(1, true));
    child.on("close", (code) => finish(code ?? 1));
  });
const prefix = [
  "--no-pager",
  "--no-lazy-fetch",
  "--no-replace-objects",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.ssh.allow=always",
  "-c",
  "http.followRedirects=false",
  "-c",
  "push.followTags=false",
  "-c",
  "push.autoSetupRemote=false",
  "-c",
  "push.gpgSign=false",
  "-c",
  "push.useForceIfIncludes=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
];
function networkEnvironment() {
  const authentication = new Set([
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_SSH_VARIANT",
    "GIT_ASKPASS",
  ]);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("GIT_") || authentication.has(key),
    ),
  );
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}
async function branchRef(repo: Repository, ref: string) {
  if (!ref.startsWith("refs/heads/") || /[\x00-\x20\x7f]/.test(ref))
    throw new PushError("Select an exact refs/heads branch");
  try {
    await git(repo.root, ["check-ref-format", ref]);
  } catch {
    throw new PushError("Select a valid full branch reference");
  }
}
async function directLocalOid(repo: Repository, ref: string) {
  await branchRef(repo, ref);
  let symbolic = false;
  try {
    await git(repo.root, ["symbolic-ref", "--quiet", "--no-recurse", ref]);
    symbolic = true;
  } catch {}
  if (symbolic)
    throw new PushError(
      "Symbolic local branches cannot be pushed by this action",
    );
  try {
    return await gitText(repo.root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
  } catch {
    throw new PushError("Selected local branch is unavailable", 409);
  }
}
async function recipient(repo: Repository, name: string) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
    name.includes("..") ||
    name.endsWith(".lock")
  )
    throw new PushError("Select one existing named remote");
  const config = await readRemoteConfiguration(repo),
    values = config.values;
  if (hasUnsafeRedirectOverrides(values))
    throw new PushError(
      "URL-scoped HTTP redirects are unsupported; configure each redirect override as false before Push",
    );
  const fetchUrls = values.get(`remote.${name}.url`) ?? [];
  const pushUrls = values.get(`remote.${name}.pushurl`) ?? [];
  if (
    !fetchUrls.length ||
    pushUrls.length > 1 ||
    (!pushUrls.length && fetchUrls.length !== 1)
  )
    throw new PushError(
      "Configure one unambiguous push URL for this named remote",
    );
  for (const key of [
    `remotes.${name}`,
    `remote.${name}.vcs`,
    `remote.${name}.receivepack`,
    `remote.${name}.uploadpack`,
    `remote.${name}.serveroption`,
    `remote.${name}.push`,
    `remote.${name}.pushoption`,
    "push.pushoption",
    "core.alternaterefscommand",
  ])
    if (values.has(key))
      throw new PushError(
        "Custom helpers, push options, remote groups and default push refspecs are unsupported",
      );
  if (
    (values.get(`remote.${name}.mirror`) ?? []).some(
      (value) => !/^(false|no|off|0)$/i.test(value),
    )
  )
    throw new PushError(
      "Mirror remotes cannot be used for manual single-branch Push",
    );
  let urls: string[];
  try {
    urls = (
      await gitText(repo.root, ["remote", "get-url", "--push", "--all", name])
    ).split("\n");
  } catch {
    throw new PushError("Unable to resolve this remote push recipient");
  }
  if (urls.length !== 1)
    throw new PushError("Multiple push recipients are unsupported");
  const rawUrl = urls[0]!,
    safe = describeRemoteUrl(rawUrl);
  if (safe.transport !== "https" && safe.transport !== "ssh")
    throw new PushError("The effective push URL must use HTTPS or SSH");
  // The fixed, already-resolved URL is passed to Git. Any matching rewrite could
  // reinterpret it a second time, so refuse that configuration rather than guess.
  for (const [key, prefixes] of values)
    if (
      /^url\..*\.(insteadof|pushinsteadof)$/.test(key) &&
      prefixes.some((value) => rawUrl.startsWith(value))
    )
      throw new PushError(
        "Push URL rewrites would apply again; configure an explicit final recipient URL",
      );
  return {
    rawUrl,
    recipient: { url: safe.url, transport: safe.transport } as PushRecipient,
    configHash: fingerprint(config.bytes),
    configValues: values,
  };
}
interface Snapshot {
  workspace: string;
  refs: string;
  config: string;
  sourceOid: string;
  rawUrl: string;
  worktree: { branch: string | null; head: string };
  recipient: PushRecipient;
}
export type PushObservationReader = (
  repositoryId: string,
  reviewId: string,
) => Promise<{ repository: Repository; observation: ReviewObservation }>;
interface StoredPlan {
  preview: PushPreview;
  snapshot: Snapshot;
  expires: number;
}
export class ManualPushService {
  private plans = new Map<string, StoredPlan>();
  constructor(
    private access: PushObservationReader,
    private options: {
      queue: RepositoryQueue;
      transport?: PushTransport;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async snapshot(
    repo: Repository,
    o: ReviewObservation,
    request: Pick<
      PushPreviewRequest,
      "localRef" | "remote" | "destinationRef" | "comparisonRef"
    >,
  ): Promise<Snapshot> {
    if (o.historical)
      throw new PushError("Historical reviews cannot authorize Push", 409);
    if (request.localRef !== (o.targetRef ?? o.branch))
      throw new PushError(
        "Push must use the exact selected local comparison branch",
        409,
      );
    await branchRef(repo, request.destinationRef);
    const expected = o.worktree ?? { branch: o.branch, head: o.head };
    await validateIdentity(repo, expected);
    await validateWriteDestinations(repo, {
      objects: true,
      branch: request.localRef,
      remote: request.remote,
    });
    const sourceOid = await directLocalOid(repo, request.localRef);
    if (sourceOid !== o.head)
      throw new PushError(
        "Selected local branch changed; refresh before Push",
        409,
      );
    const resolved = await recipient(repo, request.remote);
    if (request.comparisonRef !== undefined) {
      const mapping = (
        await getComparisonDestinations(repo, resolved.configValues)
      ).find((item) => item.trackingRef === request.comparisonRef);
      if (
        request.comparisonRef !== o.baseRef ||
        !mapping ||
        mapping.remote !== request.remote ||
        mapping.destinationRef !== request.destinationRef
      )
        throw new PushError(
          "Comparison destination changed or is unavailable; refresh and preview again",
          409,
        );
    }
    const workspace = await executionStamp(repo);
    const refs = fingerprint(
      await git(repo.root, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
      ]),
    );
    await validateIdentity(repo, expected);
    return {
      workspace,
      refs,
      config: resolved.configHash,
      sourceOid,
      rawUrl: resolved.rawUrl,
      worktree: expected,
      recipient: resolved.recipient,
    };
  }
  private async transmit(repo: Repository, args: string[], pushing: boolean) {
    try {
      const result = await (this.options.transport ?? nativePushTransport)(
        "git",
        [...prefix, "-C", repo.root, ...args],
        {
          shell: false,
          env: networkEnvironment(),
          encoding: "buffer",
          timeout: TIMEOUT,
          maxBuffer: OUTPUT_LIMIT,
        },
      );
      if (
        !Buffer.isBuffer(result.stdout) ||
        result.stdout.length > OUTPUT_LIMIT ||
        !Number.isInteger(result.code)
      )
        throw new Error("Invalid bounded protocol output");
      return result;
    } catch {
      throw new PushError(
        pushing
          ? "Push outcome is uncertain after a connection or output failure; inspect the remote before trying again"
          : "Remote-tip inspection failed; check existing local authentication and remote access",
        502,
        pushing ? "uncertain" : "not-pushed",
      );
    }
  }
  private async inspect(repo: Repository, url: string, destinationRef: string) {
    const result = await this.transmit(
      repo,
      [
        "ls-remote",
        "--quiet",
        "--heads",
        "--refs",
        "--upload-pack=git-upload-pack",
        "--",
        url,
        destinationRef,
      ],
      false,
    );
    if (result.code !== 0)
      throw new PushError(
        "Remote-tip inspection failed; check existing local authentication and remote access",
        502,
      );
    if (!result.stdout.length) return null;
    const text = result.stdout.toString("utf8");
    if (!Buffer.from(text).equals(result.stdout))
      throw new PushError("Remote-tip response could not be verified", 502);
    const lines = text.split("\n").filter(Boolean);
    if (lines.length !== 1)
      throw new PushError(
        "Remote destination is ambiguous or unsupported",
        502,
      );
    const match = /^([0-9a-f]{40,64})\t(refs\/heads\/[^\r\n]+)$/.exec(
      lines[0]!,
    );
    if (!match || match[2] !== destinationRef)
      throw new PushError("Remote-tip response could not be verified", 502);
    return match[1]!;
  }
  private async outgoing(
    repo: Repository,
    sourceOid: string,
    destinationOid: string | null,
  ): Promise<PushPreview["outgoing"]> {
    if (destinationOid) {
      try {
        await git(repo.root, ["cat-file", "-e", `${destinationOid}^{commit}`]);
      } catch {
        throw new PushError(
          "The inspected remote tip is not available locally; fetch that recipient explicitly with Git and refresh before Push",
        );
      }
      try {
        await git(repo.root, [
          "merge-base",
          "--is-ancestor",
          destinationOid,
          sourceOid,
        ]);
      } catch {
        throw new PushError(
          "Remote destination is not an ancestor of the selected branch; reconcile it in Git. Force-push is disabled",
          409,
        );
      }
    }
    const revision = destinationOid
      ? `${destinationOid}..${sourceOid}`
      : sourceOid;
    const total = Number(
      await gitText(repo.root, ["rev-list", "--count", revision]),
    );
    if (!Number.isSafeInteger(total) || total < 0)
      throw new PushError("Outgoing commits could not be verified");
    const raw = await git(repo.root, [
      "log",
      `--max-count=${COMMIT_LIMIT}`,
      "--format=%H%x00%ct%x00%s",
      revision,
    ]);
    const commits = raw
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [oid, time, ...subject] = line.split("\0");
        if (
          !oid ||
          !/^[0-9a-f]{40,64}$/.test(oid) ||
          !time ||
          !/^\d+$/.test(time)
        )
          throw new PushError("Outgoing commit metadata could not be verified");
        const date = new Date(Number(time) * 1000);
        if (!Number.isFinite(date.getTime()))
          throw new PushError("Outgoing commit time is unsupported");
        return {
          oid,
          committedAt: date.toISOString(),
          subject: subject
            .join(" ")
            .replace(/[\x00-\x1f\x7f]/g, " ")
            .slice(0, 300),
        };
      });
    return { total, commits, truncated: total > commits.length };
  }
  async preview(
    repositoryId: string,
    request: PushPreviewRequest,
  ): Promise<PushPreview> {
    return this.options.queue.run(repositoryId, async () => {
      const { repository: repo, observation: o } = await this.access(
        repositoryId,
        request.reviewId,
      );
      const snapshot = await this.snapshot(repo, o, request);
      const destinationOid = await this.inspect(
        repo,
        snapshot.rawUrl,
        request.destinationRef,
      );
      const outgoing = await this.outgoing(
        repo,
        snapshot.sourceOid,
        destinationOid,
      );
      const latest = await this.access(repositoryId, request.reviewId);
      const after = await this.snapshot(
        latest.repository,
        latest.observation,
        request,
      );
      if (fingerprint(snapshot) !== fingerprint(after))
        throw new PushError(
          "Repository changed during remote inspection; refresh and preview again",
          409,
        );
      const expires = this.now() + PLAN_TTL;
      const preview: PushPreview = {
        previewId: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        repositoryId,
        reviewId: request.reviewId,
        reviewFingerprint: o.fingerprint,
        localRef: request.localRef,
        sourceOid: snapshot.sourceOid,
        worktree: snapshot.worktree,
        remote: request.remote,
        recipient: snapshot.recipient,
        destinationRef: request.destinationRef,
        ...(request.comparisonRef === undefined
          ? {}
          : { comparisonRef: request.comparisonRef }),
        destinationOid,
        newBranch: destinationOid === null,
        upToDate: destinationOid === snapshot.sourceOid,
        outgoing,
      };
      for (const [id, plan] of this.plans)
        if (plan.expires <= this.now()) this.plans.delete(id);
      this.plans.set(preview.previewId, { preview, snapshot, expires });
      while (this.plans.size > 128)
        this.plans.delete(this.plans.keys().next().value!);
      return preview;
    });
  }
  async confirm(repositoryId: string, previewId: string): Promise<PushResult> {
    return this.options.queue.run(repositoryId, async () => {
      const plan = this.plans.get(previewId);
      if (!plan || plan.preview.repositoryId !== repositoryId)
        throw new PushError("Push preview is missing or no longer valid", 409);
      // Consume before any network transmission, including the second read-only tip inspection.
      this.plans.delete(previewId);
      if (plan.expires <= this.now())
        throw new PushError(
          "Push preview expired; inspect and confirm again",
          409,
        );
      const p = plan.preview;
      let context = await this.access(repositoryId, p.reviewId);
      const check = async () => {
        const snapshot = await this.snapshot(
          context.repository,
          context.observation,
          p,
        );
        if (
          context.observation.fingerprint !== p.reviewFingerprint ||
          fingerprint(snapshot) !== fingerprint(plan.snapshot)
        )
          throw new PushError(
            "Push context changed; refresh and preview again",
            409,
          );
      };
      await check();
      const currentTip = await this.inspect(
        context.repository,
        plan.snapshot.rawUrl,
        p.destinationRef,
      );
      if (currentTip !== p.destinationOid)
        throw new PushError(
          "Remote branch changed after preview; inspect and confirm the new plan",
          409,
        );
      context = await this.access(repositoryId, p.reviewId);
      await check();
      const result: PushResult = {
        ok: true,
        outcome: p.upToDate ? "up-to-date" : "pushed",
        remote: p.remote,
        recipient: p.recipient,
        localRef: p.localRef,
        sourceOid: p.sourceOid,
        destinationRef: p.destinationRef,
      };
      if (p.upToDate) return result;
      // Exact OID refspec pins approved bytes. Normal receive-side non-force validation
      // remains authoritative if the remote moves after this inspection; no lease/force retry.
      const sent = await this.transmit(
        context.repository,
        [
          "push",
          "--porcelain",
          "--no-progress",
          "--no-force",
          "--no-force-if-includes",
          "--no-mirror",
          "--no-all",
          "--no-tags",
          "--no-follow-tags",
          "--no-prune",
          "--no-set-upstream",
          "--no-signed",
          "--recurse-submodules=no",
          "--receive-pack=git-receive-pack",
          "--",
          plan.snapshot.rawUrl,
          `${p.sourceOid}:${p.destinationRef}`,
        ],
        true,
      );
      const statuses = sent.stdout
        .toString("utf8")
        .split("\n")
        .map((line) => /^([ =*!+\-])\t([^\t]+):([^\t]+)\t/.exec(line))
        .filter((m): m is RegExpExecArray => !!m);
      if (
        statuses.length === 1 &&
        statuses[0]![1] === "!" &&
        statuses[0]![3] === p.destinationRef
      )
        throw new PushError(
          "The remote rejected this non-force push; refresh and reconcile in Git before a new attempt",
          409,
          "rejected",
        );
      if (
        sent.code !== 0 ||
        statuses.length !== 1 ||
        ![" ", "*", "="].includes(statuses[0]![1]!) ||
        statuses[0]![2] !== p.sourceOid ||
        statuses[0]![3] !== p.destinationRef
      )
        throw new PushError(
          "Push outcome could not be verified; inspect the remote before trying again",
          502,
          "uncertain",
        );
      if (statuses[0]![1] === "=") result.outcome = "up-to-date";
      return result;
    });
  }
}

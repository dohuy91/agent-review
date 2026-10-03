import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  Repository,
  DiscardPreview,
  GitCapabilities,
} from "../../../../packages/shared/src/index.js";
import type { ReviewAccess } from "./reviews.js";
import { agentDefaults } from "../../../../packages/agents/src/defaults.js";
import {
  assertReviewFile,
  discardFile,
  GitActionError,
  indexEntry,
  mutateIndex,
  RepositoryQueue,
} from "../../../../packages/git/src/mutations.js";
import { commitSelected } from "../../../../packages/git/src/commit.js";
import {
  fetchRemote,
  getRemotes,
  readRemoteConfiguration,
  type FetchTransport,
} from "../../../../packages/git/src/remotes.js";
import { getComparisonDestinations } from "../../../../packages/git/src/comparison-destinations.js";
import { StaleReviewError } from "../../../../packages/git/src/review.js";
import { fingerprint } from "../../../../packages/review/src/fingerprint.js";
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    throw new GitActionError("Invalid Git action request");
  return value as Record<string, unknown>;
}
function required(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new GitActionError("Required action field is missing");
  return value;
}
export function installGitActionRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  options: {
    container?: boolean;
    enableWrites?: boolean;
    fetchTransport?: FetchTransport;
    queue?: RepositoryQueue;
  },
) {
  const writesEnabled =
    options.enableWrites ?? agentDefaults(options.container).enableWrites;
  const queue = options.queue ?? new RepositoryQueue();
  const previews = new Map<
    string,
    { preview: DiscardPreview; reviewId: string; expires: number }
  >();
  const repository = (id: string) => {
    const repo = repositories.get(id);
    if (!repo) throw new GitActionError("Repository is not registered", 404);
    return repo;
  };
  const writable = () => {
    if (!writesEnabled)
      throw new GitActionError(
        "Writes are disabled; enable writes explicitly for this environment",
        403,
      );
  };
  const execute = async <T>(
    fn: () => Promise<T>,
    reply: { code: (status: number) => { send: (body: object) => unknown } },
  ) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GitActionError)
        return reply.code(e.statusCode).send({ error: e.message });
      if (e instanceof StaleReviewError)
        return reply.code(409).send({
          error: "Repository or review changed; refresh before retrying",
        });
      throw e;
    }
  };
  const current = async (id: string, reviewId: string) => {
    const result = await access.getObservation(id, reviewId);
    if (result.observation.historical) throw new StaleReviewError();
    await access.validateExecution(id, reviewId);
    return result;
  };
  const capabilities: GitCapabilities = {
    writesEnabled,
    fetchEnabled: writesEnabled,
    reason: writesEnabled ? null : "Writes are disabled for this environment",
    hunkStageMode: "working",
    hunkUnstageMode: "staged",
  };
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/capabilities",
    async (req) => {
      repository(req.params.id);
      return capabilities;
    },
  );
  app.get("/api/capabilities", async () => capabilities);
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/git",
    async (req, reply) =>
      execute(async () => {
        writable();
        const b = body(req.body, ["reviewId", "action", "path", "hunkIndex"]);
        const reviewId = required(b.reviewId),
          path = required(b.path);
        if (
          (b.action !== "stage" && b.action !== "unstage") ||
          (b.hunkIndex !== undefined &&
            (!Number.isInteger(b.hunkIndex) || Number(b.hunkIndex) < 0))
        )
          throw new GitActionError("Valid stage or unstage action required");
        const action = b.action;
        return queue.run(req.params.id, async () => {
          const { repository: repo, observation: o } = await current(
            req.params.id,
            reviewId,
          );
          return mutateIndex(
            repo,
            o,
            path,
            action,
            b.hunkIndex as number | undefined,
            () => access.validateExecution(req.params.id, reviewId),
          );
        });
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/discard-preview",
    async (req, reply) =>
      execute(async () => {
        writable();
        const b = body(req.body, ["reviewId", "path"]);
        const reviewId = required(b.reviewId),
          path = required(b.path);
        return queue.run(req.params.id, async () => {
          const { repository: repo, observation: o } = await current(
            req.params.id,
            reviewId,
          );
          const file = await assertReviewFile(repo, o, path);
          const entry = await indexEntry(repo, path);
          const preview: DiscardPreview = {
            previewId: randomUUID(),
            target: {
              repositoryId: repo.id,
              worktreeRoot: repo.root,
              gitDir: repo.gitDir,
              commonDir: repo.commonDir,
              head: o.head,
              branch: o.branch,
              reviewFingerprint: o.fingerprint,
            },
            path,
            fingerprint: fingerprint([o.fingerprint, file.fingerprint, entry]),
            operation: entry ? "restore-index" : "delete-untracked",
          };
          await access.validateExecution(req.params.id, reviewId);
          previews.set(preview.previewId, {
            preview,
            reviewId,
            expires: Date.now() + 10 * 60 * 1000,
          });
          while (previews.size > 128)
            previews.delete(previews.keys().next().value!);
          return preview;
        });
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/discard",
    async (req, reply) =>
      execute(async () => {
        writable();
        const b = body(req.body, ["previewId", "confirmed"]);
        const previewId = required(b.previewId);
        if (b.confirmed !== true)
          throw new GitActionError("Explicit discard confirmation is required");
        return queue.run(req.params.id, async () => {
          const saved = previews.get(previewId);
          if (
            !saved ||
            saved.expires < Date.now() ||
            saved.preview.target.repositoryId !== req.params.id
          )
            throw new StaleReviewError();
          previews.delete(previewId);
          const { repository: repo, observation: o } = await current(
            req.params.id,
            saved.reviewId,
          );
          return discardFile(repo, o, saved.preview.path, () =>
            access.validateExecution(req.params.id, saved.reviewId),
          );
        });
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/commit",
    async (req, reply) =>
      execute(async () => {
        writable();
        const b = body(req.body, ["reviewId", "paths", "message"]);
        const reviewId = required(b.reviewId),
          message = required(b.message);
        if (
          !message.trim() ||
          message.length > 8192 ||
          !Array.isArray(b.paths) ||
          !b.paths.length ||
          b.paths.length > 128 ||
          b.paths.some((p) => typeof p !== "string" || !p) ||
          new Set(b.paths).size !== b.paths.length
        )
          throw new GitActionError(
            "Select unique staged paths and a non-empty commit message",
          );
        const paths = b.paths as string[];
        return queue.run(req.params.id, async () => {
          const { repository: repo, observation: o } = await current(
            req.params.id,
            reviewId,
          );
          return commitSelected(repo, o, paths, message, () =>
            access.validateExecution(req.params.id, reviewId),
          );
        });
      }, reply),
  );
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/remotes",
    async (req, reply) =>
      execute(async () => {
        const repo = repository(req.params.id);
        const remotes = await getRemotes(repo);
        const config = await readRemoteConfiguration(repo);
        return {
          remotes,
          comparisonDestinations: await getComparisonDestinations(
            repo,
            config.values,
          ),
        };
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/fetch",
    async (req, reply) =>
      execute(async () => {
        writable();
        const b = body(req.body, ["reviewId", "remote", "expectedHead"]);
        const reviewId = required(b.reviewId),
          remote = required(b.remote),
          expectedHead = required(b.expectedHead);
        if (!/^[a-f0-9]{40,64}$/.test(expectedHead))
          throw new GitActionError("Expected HEAD is required");
        return queue.run(req.params.id, async () => {
          const { repository: repo, observation: o } = await current(
            req.params.id,
            reviewId,
          );
          if (o.historical || o.head !== expectedHead)
            throw new StaleReviewError();
          return fetchRemote(
            repo,
            remote,
            expectedHead,
            options.fetchTransport,
            o.branch,
          );
        });
      }, reply),
  );
}

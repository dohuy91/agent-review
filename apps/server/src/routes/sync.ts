import type { FastifyInstance } from "fastify";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type { ReviewStore } from "../../../../packages/review/src/store.js";
import type { ReviewAccess } from "./reviews.js";
import { GitActionError } from "../../../../packages/git/src/mutations.js";
import { StaleReviewError } from "../../../../packages/git/src/review.js";
import { SyncService, type SyncOptions } from "../sync-service.js";
function body(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new GitActionError("Invalid synchronization request");
  return value as Record<string, unknown>;
}
function required(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new GitActionError("Required synchronization field is missing");
  return value;
}
export function installSyncRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  _access: ReviewAccess,
  store: ReviewStore,
  options: SyncOptions = {},
) {
  const service = new SyncService(repositories, store, options);
  const run = async (
    fn: () => Promise<unknown> | unknown,
    reply: { code: (status: number) => { send: (value: object) => unknown } },
  ) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GitActionError)
        return reply.code(e.statusCode).send({ error: e.message });
      if (e instanceof StaleReviewError)
        return reply.code(409).send({
          error: "Repository state changed; refresh and preview again",
        });
      return reply.code(500).send({
        error:
          "Synchronization could not complete safely; refresh and inspect the repository with Git",
      });
    }
  };
  app.get("/api/sync-settings", () => service.settings());
  app.put("/api/sync-settings", async (req, reply) =>
    run(() => {
      const b = body(req.body, ["autoFetchEnabled"]);
      if (typeof b.autoFetchEnabled !== "boolean")
        throw new GitActionError("autoFetchEnabled must be a boolean");
      return service.setSettings(b.autoFetchEnabled);
    }, reply),
  );
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/git-settings",
    async (req, reply) => run(() => service.gitSettings(req.params.id), reply),
  );
  app.put<{ Params: { id: string } }>(
    "/api/repositories/:id/git-settings",
    async (req, reply) =>
      run(() => {
        const b = body(req.body, ["defaultRemote"]);
        if (b.defaultRemote !== null && typeof b.defaultRemote !== "string")
          throw new GitActionError(
            "Choose a configured default remote or null",
          );
        return service.setGitSettings(
          req.params.id,
          b.defaultRemote === null ? null : required(b.defaultRemote),
        );
      }, reply),
  );
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/sync",
    async (req, reply) => run(() => service.status(req.params.id), reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/fetch-all",
    async (req, reply) =>
      run(() => {
        body(req.body, []);
        return service.fetchAll(req.params.id);
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/pull-preview",
    async (req, reply) =>
      run(() => {
        const b = body(req.body, ["comparisonRef"]);
        return service.pullPreview(req.params.id, required(b.comparisonRef));
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/merge-preview",
    async (req, reply) =>
      run(() => {
        const b = body(req.body, ["action"]);
        if (b.action !== "continue" && b.action !== "abort")
          throw new GitActionError("Choose continue or abort");
        return service.mergePreview(req.params.id, b.action);
      }, reply),
  );
  for (const kind of ["pull", "merge"] as const)
    app.post<{ Params: { id: string } }>(
      `/api/repositories/:id/${kind}`,
      async (req, reply) =>
        run(() => {
          const b = body(req.body, ["previewId", "confirmed"]);
          if (b.confirmed !== true)
            throw new GitActionError(
              "Explicit confirmation of the exact synchronization preview is required",
            );
          return kind === "pull"
            ? service.confirmPull(req.params.id, required(b.previewId))
            : service.confirmMerge(req.params.id, required(b.previewId));
        }, reply),
    );
  app.addHook("onReady", async () => service.start());
  app.addHook("preClose", async () => service.close());
  return service;
}

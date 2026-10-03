import { attachComment } from "../../../../packages/review/src/attachment.js";
import type { FastifyInstance } from "fastify";
import type {
  Repository,
  CommentInput,
  AttachedComment,
} from "../../../../packages/shared/src/index.js";
import type { ReviewAccess } from "./reviews.js";
import { ReviewStore } from "../../../../packages/review/src/store.js";
import {
  attach,
  makeAnchor,
  invalid,
} from "../../../../packages/review/src/anchors.js";
import { getFileDiff } from "../../../../packages/git/src/diff.js";
import {
  getProfiles,
  putProfile,
} from "../../../../packages/review/src/profiles.js";
import type {
  ProfileScope,
  SkillProfile,
  ReviewExport,
} from "../../../../packages/shared/src/index.js";
import { git } from "../../../../packages/git/src/git.js";
export function installCommentRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  store: ReviewStore,
) {
  const repo = (id: string) => {
    const r = repositories.get(id);
    if (!r)
      throw Object.assign(new Error("Unknown repository"), { statusCode: 404 });
    return r;
  };
  app.post<{ Params: { id: string }; Body: CommentInput }>(
    "/api/repositories/:id/comments",
    async (req, reply) => {
      const b = req.body;
      if (
        !b ||
        typeof b.reviewId !== "string" ||
        typeof b.path !== "string" ||
        typeof b.body !== "string" ||
        typeof b.severity !== "string"
      )
        throw invalid();
      const { repository, observation } = await access.getObservation(
        req.params.id,
        b.reviewId,
      );
      if (observation.historical)
        throw Object.assign(new Error("Historic comparison is read-only"), {
          statusCode: 403,
        });
      const diff = await getFileDiff(repository, observation, b.path);
      return reply
        .code(201)
        .send(store.create(repository, observation, diff, b));
    },
  );
  async function attachedComments(id: string, reviewId: unknown) {
    const req = { params: { id }, query: { reviewId } };
    const repository = repo(req.params.id);
    if (typeof req.query.reviewId !== "string") throw invalid();
    const { observation } = await access.getObservation(
      repository.id,
      req.query.reviewId,
    );
    const comments = await Promise.all(
      store
        .list(repository.id)
        .map((c) => attachComment(repository, observation, c)),
    );
    return { comments };
  }
  app.get<{ Params: { id: string }; Querystring: { reviewId?: string } }>(
    "/api/repositories/:id/comments",
    async (req) => attachedComments(req.params.id, req.query.reviewId),
  );
  app.get<{ Params: { id: string }; Querystring: { reviewId: string } }>(
    "/api/repositories/:id/reviewed",
    async (req) => {
      const { observation } = await access.getObservation(
        req.params.id,
        req.query.reviewId,
      );
      return store.reviewed(req.params.id, observation);
    },
  );
  app.put<{
    Params: { id: string };
    Body: { reviewId: string; path: string; reviewed: boolean };
  }>("/api/repositories/:id/reviewed", async (req) => {
    if (
      !req.body ||
      typeof req.body.reviewId !== "string" ||
      typeof req.body.path !== "string"
    )
      throw invalid();
    const { observation } = await access.getObservation(
      req.params.id,
      req.body.reviewId,
    );
    return store.markReviewed(
      req.params.id,
      observation,
      req.body.path,
      req.body.reviewed,
    );
  });
  app.get<{ Params: { id: string }; Querystring: { reviewId: string } }>(
    "/api/repositories/:id/profiles",
    async (req) => {
      const { repository, observation } = await access.getObservation(
        req.params.id,
        req.query.reviewId,
      );
      return getProfiles(store, repository, observation);
    },
  );
  app.put<{
    Params: { id: string };
    Body: {
      reviewId: string;
      scope: ProfileScope;
      profile: SkillProfile | null;
    };
  }>("/api/repositories/:id/profiles", async (req) => {
    if (!req.body || typeof req.body.reviewId !== "string") throw invalid();
    const { repository, observation } = await access.getObservation(
      req.params.id,
      req.body.reviewId,
    );
    return putProfile(
      store,
      repository,
      observation,
      req.body.scope,
      req.body.profile,
    );
  });
  app.get<{ Params: { id: string }; Querystring: { reviewId: string } }>(
    "/api/repositories/:id/export",
    async (req): Promise<ReviewExport> => {
      const { repository: r, observation: o } = await access.getObservation(
        req.params.id,
        req.query.reviewId,
      );
      const { comments } = await attachedComments(r.id, o.id);
      await access.getObservation(r.id, o.id);
      return {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        target: {
          repositoryId: r.id,
          projectId: r.projectId,
          worktreeRoot: r.root,
          gitDir: r.gitDir,
          commonDir: r.commonDir,
          branch: o.branch,
          head: o.head,
          base: o.base,
          mergeBase: o.mergeBase,
          mode: o.mode,
          reviewFingerprint: o.fingerprint,
        },
        comments,
        profile: getProfiles(store, r, o),
      };
    },
  );
  app.patch<{
    Params: { id: string; commentId: string };
    Body: Parameters<ReviewStore["update"]>[2];
  }>("/api/repositories/:id/comments/:commentId", async (req) => {
    repo(req.params.id);
    return store.update(req.params.id, req.params.commentId, req.body);
  });
  app.delete<{ Params: { id: string; commentId: string } }>(
    "/api/repositories/:id/comments/:commentId",
    async (req, reply) => {
      repo(req.params.id);
      store.delete(req.params.id, req.params.commentId);
      return reply.code(204).send();
    },
  );
}

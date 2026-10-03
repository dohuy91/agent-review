import type { FastifyInstance } from "fastify";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type { BranchSwitchRequest } from "../../../../packages/shared/src/branch-switch.js";
import type { ReviewAccess } from "./reviews.js";
import { agentDefaults } from "../../../../packages/agents/src/defaults.js";
import {
  BranchSwitchError,
  BranchSwitchService,
} from "../../../../packages/git/src/branches.js";
import {
  GitActionError,
  type RepositoryQueue,
} from "../../../../packages/git/src/mutations.js";
import { StaleReviewError } from "../../../../packages/git/src/review.js";

export interface BranchSwitchRouteOptions {
  queue: RepositoryQueue;
  assertIdle: (repositoryId: string) => Promise<void> | void;
  container?: boolean;
  enableWrites?: boolean;
  now?: () => number;
}
function body(value: unknown, fields: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new BranchSwitchError(
      "Invalid branch-switch request",
      "unsupported",
      400,
    );
  return value as Record<string, unknown>;
}
function required(value: unknown, max = 4096) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    value.includes("\0")
  )
    throw new BranchSwitchError(
      "A valid branch-switch field is required",
      "unsupported",
      400,
    );
  return value;
}
export function installBranchSwitchRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  options: BranchSwitchRouteOptions,
) {
  const writesEnabled =
    options.enableWrites ?? agentDefaults(options.container).enableWrites;
  const service = new BranchSwitchService(
    (id, reviewId) => access.getObservation(id, reviewId),
    { ...options, repositories },
  );
  const gate = (id: string) => {
    if (!writesEnabled)
      throw new BranchSwitchError(
        "Writes are disabled for this environment",
        "unsupported",
        403,
      );
    if (!repositories.has(id))
      throw new BranchSwitchError(
        "Repository is not registered",
        "unsupported",
        404,
      );
  };
  const run = async (
    action: () => Promise<unknown>,
    reply: { code: (status: number) => { send: (body: object) => unknown } },
  ) => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof BranchSwitchError)
        return reply.code(error.statusCode).send(error.response());
      if (error instanceof StaleReviewError)
        return reply.code(409).send({
          error:
            "Repository or review changed; refresh and select the branch again",
          outcome: "not-switched",
          reason: "stale",
        });
      if (error instanceof GitActionError)
        return reply.code(error.statusCode).send({
          error: error.message,
          outcome: "not-switched",
          reason: "unsupported",
        });
      return reply.code(409).send({
        error:
          "Branch switching could not be prepared safely; use Git to inspect the repository",
        outcome: "not-switched",
        reason: "unsupported",
      });
    }
  };
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/branch-switch-preview",
    async (req, reply) =>
      run(async () => {
        gate(req.params.id);
        const b = body(req.body, ["reviewId", "targetRef"]);
        return service.preview(req.params.id, {
          reviewId: required(b.reviewId),
          targetRef: required(b.targetRef),
        });
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/branch-switch",
    async (req, reply) =>
      run(async () => {
        gate(req.params.id);
        const b = body(req.body, [
          "previewId",
          "strategy",
          "confirmed",
          "commit",
        ]);
        if (
          typeof b.strategy !== "string" ||
          !["clean", "stash", "commit"].includes(b.strategy) ||
          (b.confirmed !== undefined && b.confirmed !== true)
        )
          throw new BranchSwitchError(
            "Choose a supported branch-switch strategy",
            "unsupported",
            400,
          );
        let commit: BranchSwitchRequest["commit"];
        if (b.commit !== undefined) {
          const selection = body(b.commit, ["paths", "message"]);
          if (
            !Array.isArray(selection.paths) ||
            selection.paths.length > 128 ||
            selection.paths.some(
              (path) =>
                typeof path !== "string" || !path || path.includes("\0"),
            )
          )
            throw new BranchSwitchError(
              "Select staged paths to commit",
              "unsupported",
              400,
            );
          commit = {
            paths: selection.paths as string[],
            message: required(selection.message, 8192),
          };
        }
        if (b.strategy !== "commit" && commit)
          throw new BranchSwitchError(
            "Commit details require Commit & switch",
            "unsupported",
            400,
          );
        return service.execute(req.params.id, {
          previewId: required(b.previewId),
          strategy: b.strategy as BranchSwitchRequest["strategy"],
          ...(b.confirmed === true ? { confirmed: true } : {}),
          ...(commit ? { commit } : {}),
        });
      }, reply),
  );
}

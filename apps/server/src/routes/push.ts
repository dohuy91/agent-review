import type { FastifyInstance } from "fastify";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type { ReviewAccess } from "./reviews.js";
import {
  GitActionError,
  type RepositoryQueue,
} from "../../../../packages/git/src/mutations.js";
import {
  ManualPushService,
  PushError,
  type PushTransport,
} from "../../../../packages/git/src/push.js";
import { StaleReviewError } from "../../../../packages/git/src/review.js";
import { agentDefaults } from "../../../../packages/agents/src/defaults.js";
export interface PushRouteOptions {
  queue: RepositoryQueue;
  container?: boolean;
  enableWrites?: boolean;
  pushTransport?: PushTransport;
  now?: () => number;
}
function body(value: unknown, fields: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new PushError("Invalid manual Push request");
  return value as Record<string, unknown>;
}
function required(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.length > 4096
  )
    throw new PushError("A valid Push field is required");
  return value;
}
export function installPushRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  options: PushRouteOptions,
) {
  const writesEnabled =
    options.enableWrites ?? agentDefaults(options.container).enableWrites;
  const service = new ManualPushService(
    (id, reviewId) => access.getObservation(id, reviewId),
    {
      queue: options.queue,
      transport: options.pushTransport,
      now: options.now,
    },
  );
  const gate = (id: string) => {
    if (!writesEnabled)
      throw new PushError("Writes are disabled for this environment", 403);
    if (!repositories.has(id))
      throw new PushError("Repository is not registered", 404);
  };
  const run = async (
    action: () => Promise<unknown>,
    reply: { code: (status: number) => { send: (value: object) => unknown } },
  ) => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof PushError)
        return reply
          .code(error.statusCode)
          .send({ error: error.message, outcome: error.outcome });
      if (error instanceof StaleReviewError)
        return reply.code(409).send({
          error: "Push review context changed; refresh and preview again",
          outcome: "not-pushed",
        });
      if (error instanceof GitActionError)
        return reply
          .code(error.statusCode)
          .send({ error: error.message, outcome: "not-pushed" });
      return reply.code(500).send({
        error: "Manual Push could not be prepared safely",
        outcome: "not-pushed",
      });
    }
  };
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/push-preview",
    async (req, reply) =>
      run(async () => {
        gate(req.params.id);
        const b = body(req.body, [
          "reviewId",
          "localRef",
          "remote",
          "destinationRef",
          "comparisonRef",
          "inspectRemote",
        ]);
        if (b.inspectRemote !== true)
          throw new PushError("Explicit remote-tip inspection is required");
        return service.preview(req.params.id, {
          reviewId: required(b.reviewId),
          localRef: required(b.localRef),
          remote: required(b.remote),
          destinationRef: required(b.destinationRef),
          ...(b.comparisonRef === undefined
            ? {}
            : { comparisonRef: required(b.comparisonRef) }),
          inspectRemote: true,
        });
      }, reply),
  );
  app.post<{ Params: { id: string } }>(
    "/api/repositories/:id/push",
    async (req, reply) =>
      run(async () => {
        gate(req.params.id);
        const b = body(req.body, ["previewId", "confirmed"]);
        if (b.confirmed !== true)
          throw new PushError(
            "Explicit confirmation of the Push plan is required",
          );
        return service.confirm(req.params.id, required(b.previewId));
      }, reply),
  );
}

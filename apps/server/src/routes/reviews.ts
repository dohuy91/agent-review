import type { FastifyInstance } from "fastify";
import type {
  Repository,
  ReviewObservation,
  ReviewMode,
  ReviewHistoryEntry,
} from "../../../../packages/shared/src/index.js";
import {
  getReview,
  getHistoricalReview,
  getBranches,
  StaleReviewError,
  validateObservation,
} from "../../../../packages/git/src/review.js";
import { getFileDiff } from "../../../../packages/git/src/diff.js";
import { executionStamp } from "../../../../packages/agents/src/target.js";
export interface ReviewAccess {
  openHistorical(
    repositoryId: string,
    entry: ReviewHistoryEntry,
  ): Promise<ReviewObservation>;
  validateExecution(repositoryId: string, reviewId: string): Promise<void>;
  getObservation(
    repositoryId: string,
    reviewId: string,
  ): Promise<{
    repository: Repository;
    observation: ReviewObservation;
  }>;
}
export function installReviewRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  acceptObservation: (
    repositoryId: string,
    observation: ReviewObservation,
  ) => void = () => {},
): ReviewAccess {
  const observations = new Map<string, ReviewObservation>();
  const executionStamps = new Map<string, string | null>();
  function repository(id: string) {
    const repo = repositories.get(id);
    if (!repo)
      throw Object.assign(new Error("Repository not registered"), {
        statusCode: 404,
      });
    return repo;
  }
  const access: ReviewAccess = {
    async openHistorical(repositoryId, entry) {
      const observation = await getHistoricalReview(
        repository(repositoryId),
        entry,
      );
      observations.set(observation.id, observation);
      executionStamps.set(observation.id, null);
      while (observations.size > 128) {
        const id = observations.keys().next().value!;
        observations.delete(id);
        executionStamps.delete(id);
      }
      return observation;
    },
    async validateExecution(repositoryId, reviewId) {
      const { repository: repo } = await access.getObservation(
        repositoryId,
        reviewId,
      );
      const expected = executionStamps.get(reviewId);
      if (!expected) throw new StaleReviewError();
      try {
        if ((await executionStamp(repo)) !== expected)
          throw new StaleReviewError();
      } catch {
        throw new StaleReviewError();
      }
    },
    async getObservation(repositoryId, reviewId) {
      const repo = repository(repositoryId);
      const observation = observations.get(reviewId);
      if (!observation || observation.repositoryId !== repo.id)
        throw new StaleReviewError();
      await validateObservation(repo, observation);
      if (!observation.historical) acceptObservation(repo.id, observation);
      return { repository: repo, observation };
    },
  };
  app.get<{
    Params: {
      id: string;
    };
  }>("/api/repositories/:id/branches", async (req) =>
    getBranches(repository(req.params.id)),
  );
  app.get<{
    Params: {
      id: string;
    };
    Querystring: {
      base?: string;
      mode?: string;
    };
  }>("/api/repositories/:id/review", async (req, reply) => {
    const { base, mode } = req.query;
    if (
      typeof base !== "string" ||
      typeof mode !== "string" ||
      !["branch", "working", "staged", "full"].includes(mode)
    )
      return reply
        .code(400)
        .send({ error: "Valid base and review mode required" });
    try {
      const registered = repository(req.params.id);
      const capture = async () => {
        try {
          return await executionStamp(registered);
        } catch {
          return null;
        }
      };
      const stamp = await capture();
      const observation = await getReview(registered, base, mode as ReviewMode);
      const after = await capture();
      // Unverifiable execution state does not block Git-object read review.
      executionStamps.set(
        observation.id,
        stamp && stamp === after ? stamp : null,
      );
      acceptObservation(observation.repositoryId, observation);
      observations.set(observation.id, observation);
      while (observations.size > 128) {
        const oldest = observations.keys().next().value!;
        observations.delete(oldest);
        executionStamps.delete(oldest);
      }
      return observation;
    } catch (e) {
      if (e instanceof StaleReviewError) throw e;
      return reply
        .code(
          (
            e as {
              statusCode?: number;
            }
          ).statusCode ?? 400,
        )
        .send({ error: "Unable to resolve review endpoints" });
    }
  });
  app.get<{
    Params: {
      id: string;
    };
    Querystring: {
      reviewId?: string;
      path?: string;
    };
  }>("/api/repositories/:id/diff", async (req, reply) => {
    if (
      typeof req.query.reviewId !== "string" ||
      typeof req.query.path !== "string"
    )
      return reply.code(400).send({ error: "Review id and path required" });
    const { repository: repo, observation } = await access.getObservation(
      req.params.id,
      req.query.reviewId,
    );
    try {
      return await getFileDiff(repo, observation, req.query.path);
    } catch (e) {
      if (e instanceof StaleReviewError) throw e;
      return reply.code(400).send({ error: "Invalid review file path" });
    }
  });
  return access;
}

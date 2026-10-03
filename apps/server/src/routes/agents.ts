import { createAttachmentResolver } from "../../../../packages/review/src/attachment.js";
import { unknownCodexProvider } from "../../../../packages/shared/src/index.js";
import type { FastifyInstance } from "fastify";
import { isDeepStrictEqual } from "node:util";
import type {
  Repository,
  AgentStart,
  ReviewExport,
} from "../../../../packages/shared/src/index.js";
import type { ReviewAccess } from "./reviews.js";
import type { ReviewStore } from "../../../../packages/review/src/store.js";
import { getProfiles } from "../../../../packages/review/src/profiles.js";
import { invalid } from "../../../../packages/review/src/anchors.js";
import { SkillCatalog } from "../../../../packages/agents/src/skills.js";
import { AgentManager } from "../../../../packages/agents/src/manager.js";
import {
  codexAvailability,
  adapterAvailability,
  nativeProcessFactory,
  type ProcessFactory,
} from "../../../../packages/agents/src/adapters.js";
import { agentDefaults } from "../../../../packages/agents/src/defaults.js";
import type { RepositoryQueue } from "../../../../packages/git/src/mutations.js";
class OpenCodeUnavailableError extends Error {}
export function installAgentRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  store: ReviewStore,
  options: {
    agentAvailability?: typeof codexAvailability;
    adapterAvailability?: typeof adapterAvailability;
    container?: boolean;
    skillRoots?: string[];
    enableWrites?: boolean;
    processFactory?: ProcessFactory;
    queue?: RepositoryQueue;
  },
) {
  const defaults = agentDefaults(options.container);
  const writesEnabled = options.enableWrites ?? defaults.enableWrites;
  const catalog = new SkillCatalog(options.skillRoots ?? defaults.skillRoots);
  const manager = new AgentManager(
    store,
    options.processFactory ?? nativeProcessFactory,
  );
  const extraAvailability = new Map<
    string,
    Promise<
      import("../../../../packages/shared/src/index.js").AgentAvailability
    >
  >();
  const probeExtra =
    options.adapterAvailability ??
    (options.processFactory
      ? async (id: "claude" | "opencode") => ({
          id,
          available: true,
          version: null,
          error: null,
        })
      : adapterAvailability);
  const extra = (id: "claude" | "opencode") => {
    // OpenCode availability is a current safety decision, never UI-cache
    // authorization. Every final execution validation probes it again.
    if (id === "opencode") return probeExtra(id);
    if (!extraAvailability.has(id)) extraAvailability.set(id, probeExtra(id));
    return extraAvailability.get(id)!;
  };
  let availability: ReturnType<typeof codexAvailability> | undefined;
  const repo = (id: string) => {
    if (!repositories.has(id))
      throw Object.assign(new Error("Unknown repository"), { statusCode: 404 });
  };
  app.addHook("preClose", async () => manager.close());
  app.get("/api/agents", async () => {
    const agent = await (availability ??= (
      options.agentAvailability ?? codexAvailability
    )());
    return {
      agents: [
        { ...agent, provider: agent.provider ?? unknownCodexProvider },
        ...(await Promise.all([extra("claude"), extra("opencode")])),
      ],
      writesEnabled,
    };
  });
  app.get("/api/skills", async () => ({ skills: await catalog.metadata() }));
  app.post<{ Params: { id: string }; Body: AgentStart }>(
    "/api/repositories/:id/agents",
    async (req, reply) => {
      repo(req.params.id);
      const b = req.body;
      if (
        !b ||
        Object.keys(b).some(
          (k) => !["adapter", "reviewId", "commentIds", "expected"].includes(k),
        ) ||
        !["codex", "claude", "opencode"].includes(b.adapter) ||
        typeof b.reviewId !== "string" ||
        !Array.isArray(b.commentIds) ||
        !b.commentIds.length ||
        b.commentIds.length > 64 ||
        b.commentIds.some((id) => typeof id !== "string") ||
        new Set(b.commentIds).size !== b.commentIds.length ||
        !b.expected
      )
        throw invalid();
      if (!writesEnabled)
        throw Object.assign(new Error("Writes disabled"), { statusCode: 403 });
      const conflict = () =>
        Object.assign(new Error("Execution context changed"), {
          statusCode: 409,
        });
      async function validate(): Promise<ReviewExport> {
        const { repository: r, observation: o } = await access.getObservation(
          req.params.id,
          b.reviewId,
        );
        const target = {
          repositoryId: r.id,
          projectId: r.projectId,
          worktreeRoot: r.root,
          gitDir: r.gitDir,
          commonDir: r.commonDir,
          branch: o.branch,
          head: o.head,
          ...(o.targetRef === undefined ? {} : { targetRef: o.targetRef }),
          ...(o.baseRef === undefined ? {} : { baseRef: o.baseRef }),
          ...(o.worktree === undefined ? {} : { worktree: o.worktree }),
          base: o.base,
          mergeBase: o.mergeBase,
          mode: o.mode,
          reviewFingerprint: o.fingerprint,
        };
        const profile = getProfiles(store, r, o);
        if (
          !o.branch ||
          !profile.effective ||
          !isDeepStrictEqual(target, b.expected.target) ||
          !isDeepStrictEqual(profile, b.expected.profile)
        )
          throw conflict();
        await catalog.resolve(profile.effective);
        const selected = [];
        for (const id of b.commentIds) {
          const c = store.list(r.id).find((c) => c.id === id);
          if (!c) throw invalid();
          if (
            c.status !== "open" ||
            c.mode !== o.mode ||
            c.base !== o.base ||
            c.branch !== o.branch ||
            c.worktreeRoot !== r.root
          )
            throw conflict();
          selected.push(c);
        }
        const comments = await createAttachmentResolver(r, o).attachAll(
          selected,
        );
        if (comments.some((c) => c.attachment !== "current")) throw conflict();

        if (!isDeepStrictEqual(profile, getProfiles(store, r, o)))
          throw conflict();
        await catalog.resolve(profile.effective);
        if (b.adapter === "opencode" && !options.processFactory) {
          const current = await extra("opencode");
          if (!current.available)
            throw new OpenCodeUnavailableError(
              current.error ?? "OpenCode CLI unavailable",
            );
        }
        await access.validateExecution(r.id, o.id);
        return {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          target,
          profile,
          comments,
        };
      }
      const launch = async () => {
        try {
          const context = await validate();
          if (
            !options.processFactory &&
            b.adapter !== "opencode" &&
            !(
              await (b.adapter === "codex"
                ? (availability ??= (
                    options.agentAvailability ?? codexAvailability
                  )())
                : extra(b.adapter))
            ).available
          )
            throw Object.assign(new Error(`${b.adapter} unavailable`), {
              statusCode: 503,
            });
          const text = await catalog.resolve(context.profile.effective!);
          return reply.code(201).send(await manager.start(b, validate, text));
        } catch (error) {
          if (error instanceof OpenCodeUnavailableError)
            return reply.code(503).send({ error: error.message });
          throw error;
        }
      };
      return options.queue
        ? options.queue.run(req.params.id, launch)
        : launch();
    },
  );
  app.get<{ Params: { id: string; historyId: string } }>(
    "/api/repositories/:id/history/:historyId/review",
    async (req) => {
      repo(req.params.id);
      const entry = store
        .history(req.params.id)
        .find((r) => r.id === req.params.historyId);
      if (!entry)
        throw Object.assign(new Error("Unknown historical review"), {
          statusCode: 404,
        });
      return access.openHistorical(req.params.id, entry);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/history",
    async (req) => {
      repo(req.params.id);
      return {
        reviews: store.history(req.params.id),
        runs: manager.history(req.params.id),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/agents/history",
    async (req) => {
      repo(req.params.id);
      return { runs: manager.history(req.params.id) };
    },
  );
  app.post<{ Params: { id: string; runId: string } }>(
    "/api/repositories/:id/agents/:runId/stop",
    async (req) => {
      repo(req.params.id);
      return manager.stop(req.params.id, req.params.runId);
    },
  );
  let streams = 0;
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/repositories/:id/agents/:runId/events",
    async (req, reply) => {
      repo(req.params.id);
      const run = manager.get(req.params.id, req.params.runId);
      if (streams >= 16)
        throw Object.assign(new Error("Stream capacity"), { statusCode: 429 });
      streams++;
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      let unsubscribe: () => void = () => {};
      const send = (event: unknown) => {
        if (reply.raw.destroyed) return;
        if (reply.raw.writableLength > 128 * 1024) {
          reply.raw.destroy();
          return;
        }
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        if (
          (event as { type: string; run?: { status: string } }).type ===
            "status" &&
          (event as { run?: { status: string } }).run?.status !== "running"
        )
          reply.raw.end();
      };
      unsubscribe = manager.subscribe(req.params.id, req.params.runId, send);
      const timer = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n");
      }, 15000);
      reply.raw.once("close", () => {
        clearInterval(timer);
        unsubscribe();
        streams--;
      });
      if (run.status !== "running") reply.raw.end();
    },
  );
  return {
    hasActive: (repositoryId: string) => manager.hasActive(repositoryId),
  };
}

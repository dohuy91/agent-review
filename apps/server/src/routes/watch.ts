import type { FastifyInstance } from "fastify";
import type { Repository } from "../../../../packages/shared/src/index.js";
import { RepositoryWatch } from "../watch.js";
export function installWatchRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
) {
  const watches = new Map<string, RepositoryWatch>();
  const cancellations = new Set<() => void>();
  const streams = new Set<() => void>();
  const subscribers = new Map<string, number>();
  let closed = false,
    pending = 0;
  app.addHook("preClose", async () => {
    closed = true;
    for (const cancel of cancellations) cancel();
    for (const end of streams) end();
    await Promise.all([...watches.values()].map((w) => w.close()));
    watches.clear();
  });
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/events",
    async (req, reply) => {
      const repo = repositories.get(req.params.id);
      if (!repo) return reply.code(404).send({ error: "Unknown repository" });
      if (closed || streams.size + pending >= 16)
        return reply.code(503).send({ error: "Stream capacity" });
      pending++;
      let watcher = watches.get(repo.id);
      if (!watcher) {
        watcher = new RepositoryWatch(repo);
        watches.set(repo.id, watcher);
      }
      subscribers.set(repo.id, (subscribers.get(repo.id) || 0) + 1);
      let cancelled = false,
        cancel: () => void = () => {};
      const cancellation = new Promise<void>((resolve) => {
        cancel = () => {
          cancelled = true;
          resolve();
        };
      });
      cancellations.add(cancel);
      reply.raw.once("close", cancel);
      let unavailable = false;
      try {
        await Promise.race([watcher.ready, cancellation]);
      } catch {
        unavailable = true;
      } finally {
        pending--;
        cancellations.delete(cancel);
        reply.raw.removeListener("close", cancel);
      }
      if (
        unavailable ||
        cancelled ||
        closed ||
        reply.raw.destroyed ||
        streams.size >= 16
      ) {
        const count = (subscribers.get(repo.id) || 1) - 1;
        subscribers.set(repo.id, count);
        if (!count && watches.get(repo.id) === watcher) {
          watches.delete(repo.id);
          await watcher.close();
        }
        return reply
          .code(503)
          .send({
            error: unavailable
              ? "Live watch unavailable"
              : "Stream capacity or service closing",
          });
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.write(": connected\n\n");
      const ownedWatcher = watcher;
      const write = (text: string) => {
        if (reply.raw.destroyed || reply.raw.writableEnded) return;
        if (reply.raw.writableLength > 128 * 1024) {
          reply.raw.destroy();
          return;
        }
        reply.raw.write(text);
      };
      const unsubscribe = watcher.subscribe((type) => {
        write(`data: ${JSON.stringify({ type })}\n\n`);
      });
      const timer = setInterval(() => write(": heartbeat\n\n"), 15000);
      const end = () => reply.raw.end();
      streams.add(end);
      reply.raw.once("error", () => reply.raw.destroy());
      reply.raw.once("close", () => {
        clearInterval(timer);
        unsubscribe();
        streams.delete(end);
        const count = (subscribers.get(repo.id) || 1) - 1;
        subscribers.set(repo.id, count);
        if (!count && watches.get(repo.id) === ownedWatcher) {
          watches.delete(repo.id);
          void ownedWatcher.close();
        }
      });
    },
  );
}

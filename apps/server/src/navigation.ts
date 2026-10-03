import type { FastifyInstance, FastifyRequest } from "fastify";
interface Intent {
  revision: number;
  versioned: boolean;
  repositoryId: string | null;
  reviewTicket?: object;
}
/** Admission order handles delayed handlers; explicit revisions also handle network reordering. */
export class NavigationState {
  revision = 0;
  private target: string | null = null;
  private intents = new WeakMap<FastifyRequest, Intent>();
  private reviews = new Map<string, object>();
  constructor(app: FastifyInstance) {
    app.addHook("onRequest", async (req, reply) => {
      const path = req.url.split("?")[0]!;
      const selection =
        req.method === "PUT" &&
        /^\/api\/repositories\/[^/]+\/selection$/.test(path);
      const registration =
        req.method === "POST" && path === "/api/repositories";
      const review =
        req.method === "GET" &&
        /^\/api\/repositories\/[^/]+\/review$/.test(path);
      if (!selection && !registration && !review) return;
      const value = req.headers["x-review-navigation"];
      const versioned = value !== undefined;
      if (
        versioned &&
        (typeof value !== "string" ||
          !/^\d{1,16}$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < 1 ||
          Number(value) >= Number.MAX_SAFE_INTEGER)
      )
        return reply.code(400).send({ error: "Invalid navigation revision" });
      const repositoryId = registration
        ? null
        : decodeURIComponent(path.split("/")[3]!);
      const revision = versioned
        ? Number(value)
        : review
          ? this.revision
          : this.revision + 1;
      if (revision > this.revision) {
        this.revision = revision;
        this.target = repositoryId;
      } else if (
        revision === this.revision &&
        this.target === null &&
        repositoryId
      )
        this.target = repositoryId;
      const intent: Intent = { revision, versioned, repositoryId };
      if (review) intent.reviewTicket = {};
      this.intents.set(req, intent);
      if (review && this.current(req))
        this.reviews.set(repositoryId!, intent.reviewTicket!);
    });
  }
  current(req: FastifyRequest) {
    const intent = this.intents.get(req);
    return (
      !!intent &&
      intent.revision === this.revision &&
      (!intent.repositoryId ||
        this.target === null ||
        this.target === intent.repositoryId)
    );
  }
  versioned(req: FastifyRequest) {
    return !!this.intents.get(req)?.versioned;
  }
  acceptsContext(req: FastifyRequest, id: string) {
    const intent = this.intents.get(req);
    return (
      this.current(req) &&
      !!intent?.reviewTicket &&
      this.reviews.get(id) === intent.reviewTicket
    );
  }
}

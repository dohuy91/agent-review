import { installGitActionRoutes } from "./routes/git-actions.js";
import { installPushRoutes } from "./routes/push.js";
import { installBranchSwitchRoutes } from "./routes/branches.js";
import { installDirectoryRoutes } from "./routes/directories.js";
import { DirectoryBrowser } from "./directory-browser.js";
import { RepositoryQueue } from "../../../packages/git/src/mutations.js";
import { installWatchRoutes } from "./routes/watch.js";
import Fastify from "fastify";
import { ReviewStore } from "../../../packages/review/src/store.js";
import { installCommentRoutes } from "./routes/comments.js";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { relative, isAbsolute } from "node:path";
import { mkdir, access, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { installReviewRoutes } from "./routes/reviews.js";
import { installSecurity } from "./security.js";
import { NavigationState } from "./navigation.js";
import { RegistrationStore } from "./registration.js";
import { registerRepository, validateBase } from "./registry.js";
import type {
  Repository,
  RepositoriesResponse,
  ReviewMode,
} from "../../../packages/shared/src/index.js";
import { installAgentRoutes } from "./routes/agents.js";
import type { ProcessFactory } from "../../../packages/agents/src/adapters.js";
export interface AppOptions {
  /** Internal fixture seam; never a launch or HTTP option. */
  fetchTransport?: import("../../../packages/git/src/remotes.js").FetchTransport;
  /** Internal fixture seam; never a launch or HTTP option. */
  pushTransport?: import("../../../packages/git/src/push.js").PushTransport;
  /** Internal fixture seam, never exposed through launch options or HTTP. */
  agentAvailability?: typeof import("../../../packages/agents/src/adapters.js").codexAvailability;
  adapterAvailability?: typeof import("../../../packages/agents/src/adapters.js").adapterAvailability;
  container?: boolean;
  browseRoots?: string[];
  skillRoots?: string[];
  enableWrites?: boolean;
  processFactory?: ProcessFactory;
  port: number;
  token: string;
  dataDir: string;
  repositoryPath?: string;
  base?: string;
  mode?: ReviewMode;
}
export async function createApp(options: AppOptions) {
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.token
  )
    throw new Error("Invalid launch options");
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const canonicalDataDir = await realpath(options.dataDir);
  function validateDataLocation(repo: Repository) {
    const location = relative(repo.root, canonicalDataDir);
    if (
      !location ||
      (!location.startsWith(".." + "/") &&
        location !== ".." &&
        !isAbsolute(location))
    )
      throw new Error("Review state must be outside reviewed roots");
  }
  const directoryBrowser = await DirectoryBrowser.create({
    repositoryPath: options.repositoryPath,
    browseRoots: options.browseRoots,
    container: options.container,
    excludedPaths: [canonicalDataDir],
  });
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(cookie);
  installSecurity(app, options.port, options.token);
  installDirectoryRoutes(app, directoryBrowser);
  const navigation = new NavigationState(app);
  const store = new ReviewStore(canonicalDataDir);
  app.addHook("onClose", async () => store.close());
  const registration = new RegistrationStore(store.db);
  const restored = await registration.restore(validateDataLocation);
  const repositories = new Map<string, Repository>(
    restored.repositories.map((repo) => [repo.id, repo]),
  );
  let selectedRepositoryId: string | null = registration.selected();
  if (!selectedRepositoryId || !repositories.has(selectedRepositoryId))
    selectedRepositoryId = restored.repositories[0]?.id ?? null;
  let base: string | null = options.base ?? null;
  if (options.repositoryPath) {
    try {
      const repo = await registerRepository(options.repositoryPath);
      validateDataLocation(repo);
      if (options.base) await validateBase(repo.root, options.base);
      await registration.save(repo);
      registration.select(repo.id);
      repositories.set(repo.id, repo);
      selectedRepositoryId = repo.id;
      restored.errors = restored.errors.filter(
        (error) => error.root !== repo.root,
      );
    } catch (error) {
      await app.close();
      throw error;
    }
  }
  const initialContext = selectedRepositoryId
    ? registration.context(selectedRepositoryId)
    : null;
  base = options.base ?? initialContext?.base ?? base;
  let mode = options.mode ?? initialContext?.mode ?? "full";
  // Explicit launch flags describe the actual worktree; otherwise restore the accepted comparison target.
  let target =
    options.base !== undefined || options.mode !== undefined
      ? null
      : (initialContext?.target ?? null);
  app.get("/api/repositories", async (): Promise<RepositoriesResponse> => ({
    repositories: [...repositories.values()],
    errors: restored.errors,
    selectedRepositoryId,
    navigationRevision: navigation.revision,
    base,
    mode,
    target,
    contexts: Object.fromEntries(
      [...repositories.keys()].flatMap((id) => {
        const context = registration.context(id);
        return context ? [[id, context]] : [];
      }),
    ),
  }));
  app.put<{ Params: { id: string } }>(
    "/api/repositories/:id/selection",
    async (req, reply) => {
      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body).length
      )
        return reply
          .code(400)
          .send({ error: "Selection request must be empty" });
      const repo = repositories.get(req.params.id);
      if (!repo)
        return reply.code(404).send({ error: "Repository is not registered" });
      if (!navigation.current(req))
        return {
          ok: true,
          accepted: false,
          navigationRevision: navigation.revision,
        };
      if (selectedRepositoryId !== repo.id) {
        const previous = repositories.get(selectedRepositoryId ?? "");
        const context = registration.context(repo.id);
        base =
          context?.base ??
          (previous?.projectId === repo.projectId ? base : null);
        mode = context?.mode ?? "full";
        target = context?.target ?? null;
      }
      registration.select(repo.id);
      selectedRepositoryId = repo.id;
      return {
        ok: true,
        accepted: true,
        navigationRevision: navigation.revision,
      };
    },
  );
  app.post("/api/repositories", async (req, reply) => {
    const body = req.body as { path?: unknown } | null;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "path") ||
      typeof body.path !== "string" ||
      !body.path
    ) {
      return reply
        .code(400)
        .send({ error: "Explicit repository path required" });
    }
    try {
      const repo = await registerRepository(body.path);
      validateDataLocation(repo);
      await registration.save(repo);
      repositories.set(repo.id, repo);
      // Versioned browser registration is inventory-only. Its current client
      // performs selection separately, so dismissal cannot change durable navigation.
      if (!navigation.versioned(req) && navigation.current(req)) {
        const previous = repositories.get(selectedRepositoryId ?? "");
        const context = registration.context(repo.id);
        base =
          context?.base ??
          (previous?.projectId === repo.projectId ? base : null);
        mode = context?.mode ?? "full";
        target = context?.target ?? null;
        registration.select(repo.id);
        selectedRepositoryId = repo.id;
      }
      restored.errors = restored.errors.filter(
        (error) => error.root !== repo.root,
      );
      return repo;
    } catch {
      return reply.code(400).send({
        error: "Path must identify an existing Git worktree with a commit",
      });
    }
  });
  const reviewAccess = installReviewRoutes(
    app,
    repositories,
    (id, observation, context) => {
      store.acceptObservation(id, observation);
      if (context && !observation.historical) {
        registration.saveContext(id, context);
        if (id === selectedRepositoryId) {
          base = context.base;
          mode = context.mode;
          target = context.target ?? null;
        }
      }
    },
    (req, id) => navigation.acceptsContext(req, id),
  );
  const queue = new RepositoryQueue();
  const agentAccess = installAgentRoutes(
    app,
    repositories,
    reviewAccess,
    store,
    { ...options, queue },
  );
  installCommentRoutes(app, repositories, reviewAccess, store);
  installWatchRoutes(app, repositories);
  installGitActionRoutes(app, repositories, reviewAccess, {
    ...options,
    queue,
  });
  installPushRoutes(app, repositories, reviewAccess, { ...options, queue });
  installBranchSwitchRoutes(app, repositories, reviewAccess, {
    ...options,
    queue,
    assertIdle: async (id) => {
      if (agentAccess.hasActive(id))
        throw Object.assign(new Error("An agent is still active"), {
          statusCode: 409,
        });
    },
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    return reply
      .code(status)
      .send({ error: status < 500 ? "Invalid request" : "Request failed" });
  });
  const root = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  try {
    await access(root);
    await app.register(staticFiles, { root });
  } catch {
    app.get("/", async (_req, reply) =>
      reply
        .type("text/html")
        .send(
          '<!doctype html><html><head><title>Agent Review</title></head><body><h1>Agent Review</h1><p>The web application has not been built yet.</p><script src="/bootstrap.js"></script></body></html>',
        ),
    );
  }
  app.get("/bootstrap.js", async (_req, reply) =>
    reply
      .type("application/javascript")
      .send(
        "const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname+location.search);if(token)fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)document.body.append('Session bootstrap failed');});",
      ),
  );
  return app;
}

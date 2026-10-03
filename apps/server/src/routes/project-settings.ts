import type { FastifyInstance } from "fastify";
import { opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Repository } from "../../../../packages/shared/src/index.js";
import type {
  ProjectAgentSettingsRequest,
  AgentFoldersResponse,
} from "../../../../packages/shared/src/project-settings.js";
import type { ReviewStore } from "../../../../packages/review/src/store.js";
import {
  getProjectAgentSettings,
  putProjectAgentSettings,
  validateStartingFolder,
  validateProjectAgentSettings,
} from "../../../../packages/review/src/project-settings.js";
import { projectSkillCatalog } from "../../../../packages/agents/src/skills.js";
import { agentDefaults } from "../../../../packages/agents/src/defaults.js";
import { invalid } from "../../../../packages/review/src/anchors.js";
import type { ReviewAccess } from "./reviews.js";
import type { RepositoryQueue } from "../../../../packages/git/src/mutations.js";
export function installProjectSettingsRoutes(
  app: FastifyInstance,
  repositories: Map<string, Repository>,
  access: ReviewAccess,
  store: ReviewStore,
  options: {
    skillRoots?: string[];
    container?: boolean;
    queue?: RepositoryQueue;
  } = {},
) {
  const globalRoots =
    options.skillRoots ?? agentDefaults(options.container).skillRoots;
  const repository = (id: string) => {
    const repo = repositories.get(id);
    if (!repo)
      throw Object.assign(new Error("Unknown repository"), { statusCode: 404 });
    return repo;
  };
  const writable = async (id: string, reviewId: string) => {
    if (typeof reviewId !== "string" || !reviewId) throw invalid();
    const context = await access.getObservation(id, reviewId);
    if (context.observation.historical)
      throw Object.assign(new Error("Historic comparison is read-only"), {
        statusCode: 403,
      });
    return context;
  };
  app.get<{ Params: { id: string } }>(
    "/api/repositories/:id/project-settings",
    async (req) => getProjectAgentSettings(store, repository(req.params.id)),
  );
  app.put<{ Params: { id: string }; Body: ProjectAgentSettingsRequest }>(
    "/api/repositories/:id/project-settings",
    async (req) => {
      const body = req.body;
      if (
        !body ||
        Object.keys(body).some(
          (key) => !["reviewId", "expectedRevision", "settings"].includes(key),
        )
      )
        throw invalid();
      validateProjectAgentSettings(body.settings);
      if (
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0
      )
        throw invalid();
      const save = async () => {
        const { repository: repo } = await writable(
          req.params.id,
          body.reviewId,
        );
        await validateStartingFolder(repo, body.settings.startingFolder);
        if (body.settings.skill)
          await projectSkillCatalog(
            body.settings.startingFolder,
            globalRoots,
          ).resolve(body.settings.skill);
        await writable(req.params.id, body.reviewId);
        await validateStartingFolder(repo, body.settings.startingFolder);
        return putProjectAgentSettings(
          store,
          repo,
          body.settings,
          body.expectedRevision,
        );
      };
      return options.queue ? options.queue.run(req.params.id, save) : save();
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { reviewId: string; startingFolder?: string };
  }>("/api/repositories/:id/skills", async (req) => {
    const { repository: repo } = await writable(
      req.params.id,
      req.query.reviewId,
    );
    const startingFolder =
      req.query.startingFolder ??
      getProjectAgentSettings(store, repo).settings.startingFolder;
    await validateStartingFolder(repo, startingFolder);
    const skills = await projectSkillCatalog(
      startingFolder,
      globalRoots,
    ).metadata();
    await writable(req.params.id, req.query.reviewId);
    await validateStartingFolder(repo, startingFolder);
    return { startingFolder, skills };
  });
  app.get<{
    Params: { id: string };
    Querystring: { reviewId: string; path?: string };
  }>("/api/repositories/:id/agent-folders", async (req) => {
    const { repository: repo } = await writable(
      req.params.id,
      req.query.reviewId,
    );
    const path = await validateStartingFolder(
      repo,
      req.query.path ?? repo.root,
    );
    const folders: AgentFoldersResponse["folders"] = [];
    let visited = 0,
      truncated = false;
    const entries = await opendir(path);
    for await (const entry of entries) {
      if (visited++ >= 512 || folders.length >= 256) {
        truncated = true;
        break;
      }
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name === ".git"
      )
        continue;
      const candidate = join(path, entry.name);
      try {
        if ((await realpath(candidate)) === candidate)
          folders.push({ name: entry.name, path: candidate });
      } catch {
        /* Raced folders stay unavailable. */
      }
    }
    await validateStartingFolder(repo, path);
    await writable(req.params.id, req.query.reviewId);
    return {
      root: repo.root,
      path,
      parent: path === repo.root ? null : dirname(path),
      folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
      truncated,
    } satisfies AgentFoldersResponse;
  });
}

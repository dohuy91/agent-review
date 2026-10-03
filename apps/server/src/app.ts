import { installWatchRoutes } from "./routes/watch.js";
import Fastify from 'fastify';
import { ReviewStore } from '../../../packages/review/src/store.js';
import { installCommentRoutes } from './routes/comments.js';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { relative, isAbsolute } from 'node:path';
import { mkdir, access, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installReviewRoutes } from './routes/reviews.js';
import { installSecurity } from './security.js';
import { registerRepository, validateBase } from './registry.js';
import type { Repository, RepositoriesResponse, ReviewMode } from '../../../packages/shared/src/index.js';
import { installAgentRoutes } from './routes/agents.js';
import type { ProcessFactory } from '../../../packages/agents/src/adapters.js';
export interface AppOptions {
    /** Internal fixture seam, never exposed through launch options or HTTP. */
    agentAvailability?: typeof import('../../../packages/agents/src/adapters.js').codexAvailability;
    adapterAvailability?: typeof import('../../../packages/agents/src/adapters.js').adapterAvailability;
    container?: boolean;
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
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 || !options.token)
        throw new Error('Invalid launch options');
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = await realpath(options.dataDir);
    function validateDataLocation(repo: Repository) {
        const location = relative(repo.root, canonicalDataDir);
        if (!location || (!location.startsWith('..' + '/') && location !== '..' && !isAbsolute(location)))
            throw new Error('Review state must be outside reviewed roots');
    }
    const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
    await app.register(cookie);
    installSecurity(app, options.port, options.token);
    const repositories = new Map<string, Repository>();
    let selectedRepositoryId: string | null = null;
    let base: string | null = options.base ?? null;
    if (options.repositoryPath) {
        const repo = await registerRepository(options.repositoryPath);
        validateDataLocation(repo);
        if (options.base)
            await validateBase(repo.root, options.base);
        repositories.set(repo.id, repo);
        selectedRepositoryId = repo.id;
    }
    app.get('/api/repositories', async (): Promise<RepositoriesResponse> => ({ repositories: [...repositories.values()], selectedRepositoryId, base, mode: options.mode ?? 'full' }));
    app.post('/api/repositories', async (req, reply) => {
        const body = req.body as { path?: unknown } | null;
        if (typeof body?.path !== 'string' || !body.path) {
            return reply.code(400).send({ error: 'Explicit repository path required' });
        }
        try {
            const repo = await registerRepository(body.path);
            validateDataLocation(repo);
            const previous = selectedRepositoryId ? repositories.get(selectedRepositoryId) : undefined;
            if (previous?.projectId !== repo.projectId) {
                base = null;
            }
            repositories.set(repo.id, repo);
            selectedRepositoryId = repo.id;
            return repo;
        } catch {
            return reply.code(400).send({ error: 'Path must identify an existing Git worktree with a commit' });
        }
    });
    const store = new ReviewStore(canonicalDataDir);
    const reviewAccess = installReviewRoutes(app, repositories, (id, observation) => store.acceptObservation(id, observation));
    app.addHook('onClose', async () => store.close());
    installAgentRoutes(app, repositories, reviewAccess, store, options);
    installCommentRoutes(app, repositories, reviewAccess, store);
    installWatchRoutes(app, repositories);
    app.setErrorHandler((error, _req, reply) => {
        const status = (error as { statusCode?: number }).statusCode ?? 500;
        return reply.code(status).send({ error: status < 500 ? 'Invalid request' : 'Request failed' });
    });
    const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
    try {
        await access(root);
        await app.register(staticFiles, { root });
    }
    catch {
        app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><html><head><title>Agent Review</title></head><body><h1>Agent Review</h1><p>The web application has not been built yet.</p><script src="/bootstrap.js"></script></body></html>'));
    }
    app.get('/bootstrap.js', async (_req, reply) => reply.type('application/javascript').send("const token=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname+location.search);if(token)fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}).then(r=>{if(!r.ok)document.body.append('Session bootstrap failed');});"));
    return app;
}

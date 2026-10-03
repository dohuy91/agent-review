import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
export function installSecurity(app: FastifyInstance, port: number, token: string) {
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    const origins = new Set([...hosts].map(h => `http://${h}`));
    const sessions = new Map<string, number>();
    const ttl = 8 * 60 * 60 * 1000;
    app.addHook('onRequest', async (req, reply) => {
        reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY').header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
        if (!hosts.has(req.headers.host ?? ''))
            return reply.code(403).send({ error: 'Invalid Host' });
        if (req.headers.origin && !origins.has(req.headers.origin))
            return reply.code(403).send({ error: 'Invalid Origin' });
        const api = req.url.split('?')[0]?.startsWith('/api/');
        if (!api)
            return;
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origins.has(req.headers.origin ?? ''))
            return reply.code(403).send({ error: 'Exact local Origin required' });
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite !== undefined && fetchSite !== 'same-origin') {
            return reply.code(403).send({ error: 'Same-origin browser request required' });
        }
        if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.origin) {
            const browserMetadata = Object.keys(req.headers).some(name => name.startsWith('sec-fetch-'));
            const explicitCLI = req.headers['x-review-client'] === 'cli' && !browserMetadata;
            if (fetchSite !== 'same-origin' && !explicitCLI) {
                return reply.code(403).send({ error: 'Originless reads require same-origin browser metadata or explicit CLI traffic' });
            }
        }
        if (req.url.split('?')[0] === '/api/session' && req.method === 'POST')
            return;
        const expiry = sessions.get(req.cookies.review_session ?? '');
        if (!expiry || expiry <= Date.now())
            return reply.code(401).send({ error: 'Authentication required' });
    });
    app.post('/api/session', async (req, reply) => {
        const body = req.body as {
            token?: unknown;
        } | null;
        const provided = typeof body?.token === 'string' ? Buffer.from(body.token) : Buffer.alloc(0);
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
            return reply.code(401).send({ error: 'Invalid launch token' });
        for (const [id, expires] of sessions)
            if (expires <= Date.now())
                sessions.delete(id);
        if (sessions.size >= 32)
            return reply.code(429).send({ error: 'Session limit reached; restart the launcher' });
        const id = randomBytes(32).toString('hex');
        sessions.set(id, Date.now() + ttl);
        reply.header('Cache-Control', 'no-store').setCookie('review_session', id, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: ttl / 1000 });
        return { ok: true };
    });
}

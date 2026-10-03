import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../apps/server/src/app.js';
import { registerRepository } from '../apps/server/src/registry.js';
import { parseCLI } from '../apps/server/src/cli.js';
const dirs: string[] = [];
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function temp() { const d = await mkdtemp(join(tmpdir(), 'review-test-')); dirs.push(d); return d; }
async function app() { const a = await createApp({ port: 7373, token: 'secret', dataDir: await temp() }); apps.push(a); return a; }
const headers = { host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' };
test('rejectsForeignHostOriginAndMissingSession', async () => { const a = await app(); expect((await a.inject({ url: '/api/repositories', headers: { host: 'evil.test:7373' } })).statusCode).toBe(403); expect((await a.inject({ url: '/api/repositories', headers })).statusCode).toBe(401); expect((await a.inject({ method: 'POST', url: '/api/session', headers: { ...headers, origin: 'http://evil.test' }, payload: { token: 'secret' } })).statusCode).toBe(403); const r = await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'secret' } }); const cookie = r.cookies[0]!; expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe('Strict'); expect((await a.inject({ url: '/api/repositories', headers: { ...headers, cookie: `${cookie.name}=${cookie.value}` } })).statusCode).toBe(200); expect((await a.inject({ method: 'POST', url: '/api/repositories', headers: { host: headers.host, cookie: `${cookie.name}=${cookie.value}` }, payload: { path: '.' } })).statusCode).toBe(403); });
test('bootstrapRequiresToken', async () => { const a = await app(); for (const token of [undefined, 'wrong'])
    expect((await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token } })).statusCode).toBe(401); expect((await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'secret' } })).statusCode).toBe(200); });
test('registersLinkedWorktreeIdentity', async () => { const d = await temp(); const root = join(d, 'main'); const linked = join(d, 'linked'); const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }); git('init', '--initial-branch=main', root); git('-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial'); git('-C', root, 'worktree', 'add', '-b', 'linked', linked); const a = await registerRepository(root), b = await registerRepository(linked); expect(a.id).not.toBe(b.id); expect(a.projectId).toBe(b.projectId); expect(a.commonDir).toBe(b.commonDir); expect(a.gitDir).not.toBe(b.gitDir); expect(b.branch).toBe('refs/heads/linked'); expect(b.head).toMatch(/^[a-f0-9]{40}$/); });
test('rejectsInvalidCLIFlags', () => { for (const args of [['.', '--wat'], ['.', '--port', '0'], ['.', '--port', '65536'], ['.', '--port', '12x'], ['.', '--base', '--evil'], ['.', '--base'], ['.', 'extra']])
    expect(() => parseCLI(args)).toThrow(); expect(parseCLI(['.', '--no-open'])).toMatchObject({ port: 7373, open: false }); });
test('boundedBootstrapAndInvalidCookie', async () => { const a = await app(); expect((await a.inject({ url: '/api/repositories', headers: { ...headers, cookie: 'review_session=forged' } })).statusCode).toBe(401); for (let i = 0; i < 32; i++)
    expect((await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'secret' } })).statusCode).toBe(200); expect((await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'secret' } })).statusCode).toBe(429); expect((await a.inject({ url: '/', headers: { host: '127.0.0.1:7374' } })).statusCode).toBe(403); });
test('requiresExplicitValidRegistration', async () => { const a = await app(); const r = await a.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'secret' } }); const auth = { ...headers, cookie: `review_session=${r.cookies[0]!.value}` }; for (const payload of [{}, { path: await temp() }])
    expect((await a.inject({ method: 'POST', url: '/api/repositories', headers: auth, payload })).statusCode).toBe(400); expect((await a.inject({ url: '/api/repositories', headers: auth })).json()).toMatchObject({ repositories: [], selectedRepositoryId: null }); });

test('originlessReadsRequireSameOriginBrowserOrExplicitCLI', async () => {
 const a = await app();
 const session = await a.inject({method:'POST',url:'/api/session',headers,payload:{token:'secret'}});
 const auth={host:headers.host,cookie:`review_session=${session.cookies[0]!.value}`};
 const read = (extra:Record<string,string>)=>a.inject({url:'/api/repositories',headers:{...auth,...extra}});
 expect((await read({})).statusCode).toBe(403);
 expect((await read({'sec-fetch-site':'same-origin'})).statusCode).toBe(200);
 expect((await read({'x-review-client':'cli'})).statusCode).toBe(200);
 for(const site of ['cross-site','same-site','none']) {
  expect((await read({'sec-fetch-site':site})).statusCode).toBe(403);
  expect((await read({'sec-fetch-site':site,'x-review-client':'cli'})).statusCode).toBe(403);
  expect((await read({'sec-fetch-site':site,origin:headers.origin})).statusCode).toBe(403);
 }
 expect((await read({'sec-fetch-mode':'cors','x-review-client':'cli'})).statusCode).toBe(403);
 expect((await a.inject({method:'POST',url:'/api/repositories',headers:{...auth,'x-review-client':'cli'},payload:{path:'.'}})).statusCode).toBe(403);
});

test('selectingUnrelatedRepositoryResetsLaunchBase', async () => {
 const d=await temp(); const first=join(d,'first'), second=join(d,'second');
 for(const root of [first,second]){
  execFileSync('git',['init','--initial-branch=main',root]);
  execFileSync('git',['-C',root,'-c','user.name=Test','-c','user.email=test@example.com','commit','--allow-empty','-m','initial']);
 }
 execFileSync('git',['-C',first,'branch','only-first']);
 const a=await createApp({port:7373,token:'secret',dataDir:await temp(),repositoryPath:first,base:'only-first'});apps.push(a);
 const session=await a.inject({method:'POST',url:'/api/session',headers,payload:{token:'secret'}});
 const auth={...headers,cookie:`review_session=${session.cookies[0]!.value}`};
 expect((await a.inject({url:'/api/repositories',headers:auth})).json().base).toBe('only-first');
 expect((await a.inject({method:'POST',url:'/api/repositories',headers:auth,payload:{path:second}})).statusCode).toBe(200);
 expect((await a.inject({url:'/api/repositories',headers:auth})).json().base).toBeNull();
});

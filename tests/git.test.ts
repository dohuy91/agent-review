import { test, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerRepository } from '../apps/server/src/registry.js';
import { getReview } from '../packages/git/src/review.js';
import { getFileDiff } from '../packages/git/src/diff.js';
let roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.map(p => rm(p, { recursive: true, force: true })));
    roots = [];
});
async function externalDataDir() { const dir = await mkdtemp(join(tmpdir(), 'review-state-')); roots.push(dir); return dir; }
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'review-git-'));
    roots.push(root);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    await writeFile(join(root, 'a.txt'), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('branch', 'base');
    await writeFile(join(root, 'a.txt'), 'committed\n');
    git('commit', '-qam', 'branch');
    return { root, git, repo: await registerRepository(root) };
}
test('four real Git endpoints preserve index versus worktree and NUL names', async () => {
    const { root, git, repo } = await fixture();
    await writeFile(join(root, 'a.txt'), 'staged\n');
    git('add', '.');
    await writeFile(join(root, 'a.txt'), 'working\n');
    await writeFile(join(root, '-odd\nname'), 'untracked\n');
    for (const [mode, oldText, newText] of [['branch', 'base\n', 'committed\n'], ['staged', 'committed\n', 'staged\n'], ['working', 'staged\n', 'working\n'], ['full', 'base\n', 'working\n']] as const) {
        const r = await getReview(repo, 'base', mode);
        expect(r.files.map(f => f.path).includes('-odd\nname')).toBe(mode === 'working' || mode === 'full');
        const d = await getFileDiff(repo, r, 'a.txt');
        expect(d.oldContent).toBe(oldText);
        expect(d.newContent).toBe(newText);
        expect(d.hunks.length).toBeGreaterThan(0);
    }
});
test('mutable observations reject changes and swapped symlinks without disclosure', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'a.txt'), 'working\n');
    const r = await getReview(repo, 'base', 'working');
    await writeFile(join(root, 'a.txt'), 'changed\n');
    await expect(getFileDiff(repo, r, 'a.txt')).rejects.toThrow(/stale/i);
    const s = await getReview(repo, 'base', 'working');
    await rm(join(root, 'a.txt'));
    await symlink('/etc/passwd', join(root, 'a.txt'));
    await expect(getFileDiff(repo, s, 'a.txt')).rejects.toThrow();
    await expect(getFileDiff(repo, s, '../passwd')).rejects.toThrow();
});
test('rename deletion binary symlink and conflict explain special files', async () => {
    const { root, git, repo } = await fixture();
    git('mv', 'a.txt', 'renamed.txt');
    git('commit', '-qm', 'rename');
    const r = await getReview(repo, 'HEAD~1', 'branch');
    expect(r.files[0]?.oldPath).toBe('a.txt');
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]));
    await symlink('/etc/passwd', join(root, 'link'));
    git('add', '.');
    const s = await getReview(repo, 'HEAD', 'staged');
    expect((await getFileDiff(repo, s, 'binary')).unsupportedReason).toMatch(/binary/i);
    expect((await getFileDiff(repo, s, 'link')).unsupportedReason).toMatch(/symlink/i);
    await rm(join(root, 'renamed.txt'));
    const w = await getReview(repo, 'HEAD', 'working');
    expect((await getFileDiff(repo, w, 'renamed.txt')).newContent).toBeNull();
});
test('conflicts and submodules are explicit, and local refs are available', async () => {
    const { root, git, repo } = await fixture();
    const head = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${head},module`);
    let r = await getReview(repo, 'base', 'staged');
    expect((await getFileDiff(repo, r, 'module')).unsupportedReason).toMatch(/submodule/);
    git('reset', '--hard', '-q');
    git('checkout', '-qb', 'side', 'base');
    await writeFile(join(root, 'a.txt'), 'side\n');
    git('commit', '-qam', 'side');
    git('checkout', '-q', '-');
    try {
        git('merge', 'side');
    }
    catch { }
    r = await getReview(repo, 'base', 'working');
    expect(r.files.some(f => f.path === 'a.txt' && f.kind === 'conflict')).toBe(true);
    const conflict = await getFileDiff(repo, r, 'a.txt');
    expect(conflict.unsupportedReason).toBeNull();
    expect(conflict.oldContent).toBeNull();
    expect(conflict.newContent).toContain('<<<<<<< HEAD');
});
import { createApp } from '../apps/server/src/app.js';
test('authenticated HTTP exposes branches and rejects unknown or stale lazy ids', async () => {
    const { root } = await fixture();
    const app = await createApp({ port: 7373, token: 'test-token', dataDir: await externalDataDir(), repositoryPath: root });
    const headers = { host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' };
    const session = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'test-token' } });
    const cookie = session.headers['set-cookie']!.toString().split(';')[0]!;
    const auth = { ...headers, cookie };
    const list = await app.inject({ url: '/api/repositories', headers: auth });
    const id = list.json().repositories[0].id;
    expect((await app.inject({ url: `/api/repositories/${id}/branches`, headers: auth })).statusCode).toBe(200);
    const review = await app.inject({ url: `/api/repositories/${id}/review?base=base&mode=branch`, headers: auth });
    expect(review.statusCode).toBe(200);
    expect((await app.inject({ url: `/api/repositories/${id}/diff?reviewId=unknown&path=a.txt`, headers: auth })).statusCode).toBe(409);
    await app.close();
});
test('large additions and escaping parent symlinks never return source', async () => {
    const { root, repo } = await fixture();
    await writeFile(join(root, 'large'), 'x'.repeat(600 * 1024));
    await symlink('/etc', join(root, 'outside'));
    const r = await getReview(repo, 'base', 'working');
    const large = await getFileDiff(repo, r, 'large');
    expect(large.unsupportedReason).toMatch(/limit/);
    expect(large.newContent).toBeNull();
    await expect(getFileDiff(repo, r, 'outside/passwd')).rejects.toThrow();
});
test('endpoint lists agree with independent Git name-status CLI in every mode', async () => {
    const { root, git, repo } = await fixture();
    await writeFile(join(root, 'a.txt'), 'staged\n');
    git('add', '.');
    await writeFile(join(root, 'a.txt'), 'working\n');
    for (const [mode, args] of [['branch', ['base', 'HEAD']], ['working', []], ['staged', ['--cached', 'HEAD']], ['full', ['base']]] as const) {
        const expected = git('diff', '--name-only', '-z', ...args, '--').split('\0').filter(Boolean);
        const r = await getReview(repo, 'base', mode);
        expect(r.files.map(f => f.path)).toEqual(expected);
    }
});
test('deleted nested files retain old content after their parent directory disappears', async () => {
    const { root, git, repo } = await fixture();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/file'), 'nested\n');
    git('add', '.');
    git('commit', '-qm', 'nested');
    await rm(join(root, 'nested'), { recursive: true });
    const r = await getReview(repo, 'HEAD', 'working');
    const d = await getFileDiff(repo, r, 'nested/file');
    expect(d.unsupportedReason).toBeNull();
    expect(d.oldContent).toBe('nested\n');
    expect(d.newContent).toBeNull();
});
test('lazy diffs do not follow parent directory symlinks even inside registered root', async () => {
    const { root, git, repo } = await fixture();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested/file'), 'old\n');
    git('add', '.');
    git('commit', '-qm', 'nested');
    git('mv', 'nested', 'actual');
    git('commit', '-qm', 'move');
    await symlink('actual', join(root, 'nested'));
    await expect((await import('../packages/git/src/git.js')).readWorktree(repo.root, 'nested/file')).rejects.toThrow();
});
import { access } from 'node:fs/promises';
import { parseHunks } from '../packages/git/src/diff.js';
import { validateObservation, StaleReviewError } from '../packages/git/src/review.js';
for (const driver of ['clean', 'process'] as const)
    test(`configured ${driver} filters cannot execute during review`, async () => { const { root, git, repo } = await fixture(); const marker = join(root, `.git/${driver}-executed`); await writeFile(join(root, '.gitattributes'), '*.txt filter=probe\n'); git('config', `filter.probe.${driver}`, driver === 'clean' ? `touch '${marker}'; cat` : `touch '${marker}'; exec sleep 30`); await writeFile(join(root, 'a.txt'), 'filter-trigger\n'); let observation; try {
        observation = await getReview(repo, 'base', 'working');
        if (observation)
            await getFileDiff(repo, observation, 'a.txt');
    }
    catch { } await expect(access(marker)).rejects.toThrow(); expect(observation).toBeDefined(); }, 20000);
test('wildcard and magic filenames return only their own exact hunks', async () => { const { root, git, repo } = await fixture(); for (const name of ['*.txt', ':(glob)*.txt'])
    await writeFile(join(root, name), 'before\n'); git('add', '.'); git('commit', '-qm', 'literal names'); for (const name of ['*.txt', ':(glob)*.txt'])
    await writeFile(join(root, name), 'target\n'); await writeFile(join(root, 'a.txt'), 'other\n'); const r = await getReview(repo, 'HEAD', 'working'); for (const name of ['*.txt', ':(glob)*.txt']) {
    const d = await getFileDiff(repo, r, name);
    expect(d.hunks.flatMap(h => h.lines.filter(l => l.type === 'add').map(l => l.text))).toEqual(['target']);
} });
test('whitespace-only final additions and blank context are preserved exactly', async () => { const { root, git, repo } = await fixture(); await writeFile(join(root, 'a.txt'), 'old\n'); git('add', '.'); git('commit', '-qm', 'whitespace base'); await writeFile(join(root, 'a.txt'), 'old\n \t\n'); const r = await getReview(repo, 'HEAD', 'working'); const d = await getFileDiff(repo, r, 'a.txt'); expect(d.hunks[0]!.lines.map(l => l.text)).toEqual(['old', ' \t']); expect(d.hunks[0]!.newCount).toBe(2); });
test('patch parser resets at file headers without turning headers into source', () => { const hunks = parseHunks('diff --git a/one b/one\n--- a/one\n+++ b/one\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two b/two\n--- a/two\n+++ b/two\n@@ -1 +1 @@\n-other\n+second\n'); expect(hunks[0]!.lines.map(l => l.text)).toEqual(['old', 'new']); });
test('unborn HEAD invalidates observation as explicit stale409', async () => { const { git, repo } = await fixture(); const r = await getReview(repo, 'base', 'working'); git('checkout', '--orphan', 'unborn'); await expect(validateObservation(repo, r)).rejects.toMatchObject({ statusCode: 409 }); });
test('final empty context lines remain in hunks with matching counts', async () => { const { root, git, repo } = await fixture(); await writeFile(join(root, 'a.txt'), 'old\n\n'); git('add', '.'); git('commit', '-qm', 'blank context'); await writeFile(join(root, 'a.txt'), 'new\n\n'); const d = await getFileDiff(repo, await getReview(repo, 'HEAD', 'working'), 'a.txt'); expect(d.hunks[0]!.lines.map(l => l.text)).toEqual(['old', 'new', '']); expect(d.hunks[0]!.oldCount).toBe(2); expect(d.hunks[0]!.newCount).toBe(2); });
test('HTTP diff returns409 when HEAD becomes unborn', async () => { const { root, git } = await fixture(); const app = await createApp({ port: 7373, token: 'stale', dataDir: await externalDataDir(), repositoryPath: root }); try {
    const headers = { host: '127.0.0.1:7373', origin: 'http://127.0.0.1:7373' };
    const session = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { token: 'stale' } });
    const auth = { ...headers, cookie: session.headers['set-cookie']!.toString().split(';')[0]! };
    const id = (await app.inject({ url: '/api/repositories', headers: auth })).json().repositories[0].id;
    const observation = (await app.inject({ url: `/api/repositories/${id}/review?base=base&mode=working`, headers: auth })).json();
    git('checkout', '--orphan', 'unborn');
    expect((await app.inject({ url: `/api/repositories/${id}/diff?reviewId=${observation.id}&path=a.txt`, headers: auth })).statusCode).toBe(409);
}
finally {
    await app.close();
} });

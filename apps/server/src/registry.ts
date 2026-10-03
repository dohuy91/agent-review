import { git } from '../../../packages/git/src/git.js';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Repository } from '../../../packages/shared/src/index.js';
export async function gitRead(root: string, args: string[]): Promise<string> {
    return (await git(root, args)).toString('utf8').replace(/\n$/, '');
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export async function registerRepository(path: string): Promise<Repository> {
    const input = await realpath(path);
    const root = await realpath(await gitRead(input, ['rev-parse', '--show-toplevel']));
    const commonDir = await realpath(await gitRead(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const gitDir = await realpath(await gitRead(root, ['rev-parse', '--absolute-git-dir']));
    const head = await gitRead(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
    let branch: string | null = null;
    try {
        branch = await gitRead(root, ['symbolic-ref', '--quiet', 'HEAD']);
    }
    catch { }
    return { id: hash(`${root}\0${gitDir}`), root, commonDir, gitDir, branch, head, projectId: hash(commonDir) };
}
export async function validateBase(root: string, base: string): Promise<string> { if (!base || base.startsWith('-') || /[\x00-\x20]/.test(base))
    throw new Error('Invalid base reference'); return gitRead(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]); }

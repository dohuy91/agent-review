import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
const exec = promisify(execFile);
export const DISPLAY_LIMIT = 512 * 1024;
// All read commands share the same execution boundary. Built-in commands cannot
// invoke configured filters, hooks, fsmonitor, pagers or on-demand fetch helpers.
const readEnvironment: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
Object.assign(readEnvironment, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '',
    GIT_LITERAL_PATHSPECS: '1', GIT_NO_LAZY_FETCH: '1',
});
const readOptions = {
    encoding: 'buffer' as const, timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    env: readEnvironment,
};
const readPrefix = [
    '--no-pager', '--no-lazy-fetch', '--no-replace-objects', '--literal-pathspecs',
    '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=',
];
export async function git(root: string, args: string[]): Promise<Buffer> {
    // Attribute driver names are repository-defined. Override every effective
    // driver rather than assuming a known name such as Git LFS. Reading config
    // itself does not perform worktree conversion or run filters.
    let configKeys: Buffer;
    try {
        const result = await exec('git', [...readPrefix, '-C', root,
            'config', '--null', '--name-only', '--get-regexp',
            '^filter\\..*\\.(clean|smudge|process|required)$'], readOptions);
        configKeys = result.stdout;
    }
    catch (error) {
        if ((error as {
            code?: number;
        }).code !== 1)
            throw error;
        configKeys = Buffer.alloc(0); // No configured filter drivers.
    }
    const drivers = new Set(configKeys.toString('utf8').split('\0').filter(Boolean)
        .map(key => key.replace(/\.(clean|smudge|process|required)$/, '')));
    const overrides: string[] = [];
    for (const driver of drivers) {
        overrides.push('-c', `${driver}.clean=`, '-c', `${driver}.smudge=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`);
    }
    const { stdout } = await exec('git', [...readPrefix, ...overrides, '-C', root, ...args], readOptions);
    return stdout;
}
// Scalar outputs lose only the protocol's final newline, never source whitespace.
export async function gitText(root: string, args: string[]) {
    return (await git(root, args)).toString('utf8').replace(/\n$/, '');
}
export function validPath(path: string) {
    if (!path || isAbsolute(path) || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.' || !p))
        throw new Error('Invalid file path');
}
export async function safeStat(root: string, path: string) {
    validPath(path);
    if (await realpath(root) !== root)
        throw new Error('Registered root moved');
    const absolute = resolve(root, path);
    try {
        const parent = await realpath(resolve(absolute, '..'));
        if (parent !== resolve(absolute, '..'))
            throw new Error('Symlink parent is not displayable');
        const rel = relative(root, parent);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            throw new Error('Escaping file path');
        return await lstat(absolute, { bigint: true });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw e;
    }
}
export async function readWorktree(root: string, path: string): Promise<Buffer | null> {
    const before = await safeStat(root, path);
    if (!before)
        return null;
    if (!before.isFile())
        throw new Error('Unsupported non-regular file');
    if (before.size > BigInt(DISPLAY_LIMIT))
        throw new Error('File exceeds display limit');
    const parentBefore = await lstat(resolve(root, path, '..'), { bigint: true });
    const handle = await open(resolve(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat({ bigint: true });
        if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile())
            throw new Error('File changed during read');
        const buffer = Buffer.alloc(DISPLAY_LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > DISPLAY_LIMIT)
            throw new Error('File exceeds display limit');
        const after = await safeStat(root, path);
        const parentAfter = await lstat(resolve(root, path, '..'), { bigint: true });
        if (parentBefore.ino !== parentAfter.ino || parentBefore.dev !== parentAfter.dev)
            throw new Error('Parent changed during read');
        if (!after || after.ino !== stat.ino || after.ctimeNs !== stat.ctimeNs)
            throw new Error('File changed during read');
        return buffer.subarray(0, bytesRead);
    }
    finally {
        await handle.close();
    }
}

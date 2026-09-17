import { loadMergeIgnores, isMergeIgnored } from './merge-ignore.js';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath, readdir, unlink, rmdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep, dirname, join } from 'node:path';
import { svnCapture, svnReadStatusAsync, isConflict, isChange, type StatusEntry } from './svn.js';
import { mapConcurrent, validateMergeTargets, DEFAULT_CONCURRENCY } from './concurrency.js';
import type { ProgressCallback } from './progress.js';

export const ignoredChangelist = 'ignore-on-commit';

export function pathKey(path: string): string {
  const full = resolve(path);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function containsPath(parent: string, child: string): boolean {
  const suffix = relative(pathKey(parent), pathKey(child));
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`));
}

export function dirtyEntries(entries: StatusEntry[]): StatusEntry[] {
  return entries.filter(entry => isConflict(entry) ||
    (entry.changelist !== ignoredChangelist && (isChange(entry) || entry.text === '?')));
}

export async function fingerprint(path: string): Promise<string> {
  const hash = createHash('sha256');
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) hash.update(await readlink(path));
    else if (stat.isFile()) for await (const chunk of createReadStream(path)) hash.update(chunk);
    else hash.update('directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    hash.update('missing');
  }
  hash.update(await svnCapture(['proplist', '--xml', '--verbose', '--', `${path}@`]));
  return hash.digest('hex');
}

export async function snapshotIgnored(entries: StatusEntry[]): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of entries.filter(entry => entry.changelist === ignoredChangelist)) {
    snapshot[pathKey(entry.path)] = await fingerprint(pathKey(entry.path));
  }
  return snapshot;
}

export async function changedIgnored(snapshot: Record<string, string>): Promise<string[]> {
  const changed: string[] = [];
  for (const [path, before] of Object.entries(snapshot)) {
    try { if (await fingerprint(path) !== before) changed.push(path); }
    catch { changed.push(path); }
  }
  return changed;
}

// Resolve the parent rather than the leaf: deleting a junction removes the link,
// never its target. A path reached through an external junction is rejected.
export async function assertCleanupPath(root: string, path: string, allowRoot = false): Promise<void> {
  if (!containsPath(root, path) || (!allowRoot && pathKey(root) === pathKey(path))) {
    throw new Error(`拒绝清理工作副本范围外的路径: ${path}`);
  }
  if (pathKey(root) === pathKey(path)) return;
  let parent = dirname(resolve(path));
  while (true) {
    try {
      if (!containsPath(await realpath(root), await realpath(parent))) throw new Error(`拒绝穿过外部链接清理: ${path}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      parent = next;
    }
  }
}

export async function deleteUnversioned(root: string, path: string, protectedPaths: string[]): Promise<void> {
  if (protectedPaths.some(protectedPath => containsPath(path, protectedPath) || containsPath(protectedPath, path))) {
    throw new Error(`保留包含 ignore-on-commit 或外部副本的路径: ${path}`);
  }
  const inspect = async (entry: string): Promise<void> => {
    await assertCleanupPath(root, entry);
    const stat = await lstat(entry);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const children = await readdir(entry);
    if (children.some(child => child.toLowerCase() === '.svn')) throw new Error(`保留嵌套 SVN 工作副本: ${entry}`);
    for (const child of children) await inspect(join(entry, child));
  };
  // Validate the whole subtree before the first deletion.
  await inspect(path);
  const remove = async (entry: string): Promise<void> => {
    await assertCleanupPath(root, entry);
    const stat = await lstat(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of await readdir(entry)) await remove(join(entry, child));
      await rmdir(entry);
    } else await unlink(entry);
  };
  await remove(path);
}

export async function cleanWorkspace(root: string, onLine: (line: string) => void): Promise<void> {
  const initial = await svnReadStatusAsync(root);
  // A non-working-copy folder can appear as a single '?' status entry.
  await svnCapture(['info', '--show-item', 'wc-root', '--', `${root}@`]);
  const protectedPaths = initial.filter(entry => entry.changelist === ignoredChangelist || entry.text === 'X').map(entry => entry.path);
  const mergeIgnores = loadMergeIgnores(root);
  protectedPaths.push(...mergeIgnores);
  const before = await snapshotIgnored(initial);
  const changes = dirtyEntries(initial).filter(entry => entry.changelist !== ignoredChangelist && entry.text !== '?' && !isMergeIgnored(entry.path, mergeIgnores));
  // Revert only explicitly dirty paths. Structural directory changes require
  // their children too; property-only directory changes must stay nonrecursive.
  changes.sort((a, b) => a.path.split(/[\\/]/).length - b.path.split(/[\\/]/).length);
  const revertedTrees: string[] = [];
  for (const entry of changes) {
    if (revertedTrees.some(path => containsPath(path, entry.path))) continue;
    await assertCleanupPath(root, entry.path, true);
    if (entry.text === '~') throw new Error(`路径类型阻塞，请手动处理: ${entry.path}`);
    if ((entry.treeConflict || (entry.text !== ' ' && entry.text !== 'M')) && protectedPaths.some(path => containsPath(entry.path, path))) {
      throw new Error(`结构变更包含受保护文件，请手动处理: ${entry.path}`);
    }
    const structural = 'ADR!'.includes(entry.text) || entry.treeConflict;
    const recursive = structural && (await svnCapture(['info', '--show-item', 'kind', '--', `${entry.path}@`])).trim() === 'dir';
    if (recursive) {
      try {
        if ((await lstat(entry.path)).isSymbolicLink()) throw new Error(`结构变更路径是目录链接，请手动处理: ${entry.path}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    onLine(`revert ${entry.path}`);
    await svnCapture(['revert', '--depth', recursive ? 'infinity' : 'empty', '--', `${entry.path}@`]);
    if (recursive) revertedTrees.push(entry.path);
  }
  // Reverted additions become unversioned, so query status again before deleting.
  const current = await svnReadStatusAsync(root);
  const unversioned = current.filter(entry => entry.text === '?' && entry.changelist !== ignoredChangelist && !isMergeIgnored(entry.path, mergeIgnores));
  const topLevel = unversioned.filter(entry => !unversioned.some(other => other !== entry && containsPath(other.path, entry.path)));
  for (const entry of topLevel) {
    await deleteUnversioned(root, entry.path, protectedPaths);
    onLine(`delete ${entry.path}`);
  }
  if ((await changedIgnored(before)).length) throw new Error('ignore-on-commit 文件在清理期间变化，请检查');
}

export async function cleanWorkspaces(
  targets: Array<{ branch: string; path: string }>, concurrency = DEFAULT_CONCURRENCY,
  onProgress: ProgressCallback = () => {}, run = cleanWorkspace,
): Promise<string[]> {
  validateMergeTargets(targets);
  const issues = await mapConcurrent(targets, concurrency, async (target, index) => {
    onProgress(index, '正在检查并清理工作副本');
    try {
      await run(target.path, line => onProgress(index, line));
      onProgress(index, '清理完成，等待重新检查', { status: 'success' });
      return '';
    } catch (error) {
      const issue = `${target.branch}: 清理未完成: ${String(error)}`;
      onProgress(index, issue, { status: 'error' });
      return issue;
    }
  });
  return issues.filter(Boolean);
}

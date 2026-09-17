import { existsSync, readFileSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseDocument } from 'yaml';
import { containsPath, pathKey, assertCleanupPath, ignoredChangelist, deleteUnversioned } from './workspace.js';
import { svnCapture, isChange, isConflict, type StatusEntry } from './svn.js';

export function loadMergeIgnores(root: string): string[] {
  const file = ['svnmerge.yaml', 'svnmerge.yml'].map(name => join(root, name)).find(existsSync);
  if (!file) return [];
  const document = parseDocument(readFileSync(file, 'utf8'));
  if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);
  const config = document.toJS();
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`${file}: 配置必须是 YAML mapping`);
  if (config.ignore === undefined) return [];
  if (!Array.isArray(config.ignore) || config.ignore.some((item: unknown) => typeof item !== 'string' || !item.trim())) throw new Error(`${file}: ignore 必须是非空路径字符串列表`);
  return [...new Set<string>(config.ignore.map((item: string) => {
    const path = resolve(root, item.trim().replace(/\\/g, '/'));
    if (!containsPath(root, path) || pathKey(path) === pathKey(root) || containsPath(join(root, '.svn'), path)) throw new Error(`${file}: ignore 路径超出允许范围: ${item}`);
    return path;
  }))];
}

export const isMergeIgnored = (path: string, ignores: string[]) => ignores.some(ignore => containsPath(ignore, path));

export async function revertMergeIgnores(root: string, ignores: string[], state: StatusEntry[], onLine: (line: string) => void): Promise<void> {
  const protectedPaths = state.filter(entry => entry.changelist === ignoredChangelist || entry.text === 'X').map(entry => entry.path);
  const reverted: string[] = [];
  for (const entry of [...state].sort((a, b) => a.path.length - b.path.length)) {
    if (!isMergeIgnored(entry.path, ignores) || (!isChange(entry) && !isConflict(entry)) || reverted.some(parent => containsPath(parent, entry.path))) continue;
    await assertCleanupPath(root, entry.path);
    if (protectedPaths.some(path => containsPath(entry.path, path) || containsPath(path, entry.path))) throw new Error(`ignore 规则涉及受保护路径，需人工处理: ${entry.path}`);
    const stat = await lstat(entry.path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (stat?.isSymbolicLink()) throw new Error(`ignore 路径是目录链接或符号链接，需人工处理: ${entry.path}`);
    // Recursive revert also restores children of deleted/replaced directories.
    await svnCapture(['revert', '--depth', 'infinity', '--', `${entry.path}@`]);
    if (entry.text === 'A' && existsSync(entry.path)) await deleteUnversioned(root, entry.path, protectedPaths);
    reverted.push(entry.path);
    onLine(`已忽略并恢复: ${entry.path}`);
  }
}

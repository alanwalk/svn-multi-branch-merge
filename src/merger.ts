import { loadMergeIgnores, isMergeIgnored, revertMergeIgnores } from './merge-ignore.js';
import { existsSync } from 'node:fs';
import { mapConcurrent, validateMergeTargets, DEFAULT_CONCURRENCY } from './concurrency.js';
import type { ProgressCallback } from './progress.js';
export { validateMergeTargets } from './concurrency.js';
import stringWidth from 'string-width';
import type { LogEntry } from './types.js';
import {
  svnUpdate, svnMerge, svnResolve, svnReadStatusAsync, svnCommit, svnMergedRevisions,
  isConflict, isChange, type StatusEntry,
} from './svn.js';
import { dirtyEntries, snapshotIgnored, changedIgnored, ignoredChangelist, pathKey, containsPath } from './workspace.js';

export interface ConflictResult {
  path: string;
  tree: boolean;
  resolution: 'unresolved' | 'theirs-full' | 'working';
  reason?: string;
}

export interface MergeResult {
  branch: string;
  path: string;
  status: 'ready' | 'unchanged' | 'conflict' | 'error' | 'committed';
  changes: StatusEntry[];
  conflicts: ConflictResult[];
  message?: string;
  revisions?: string[];
  skippedRevisions?: string[];
  commitMessage?: string;
  mergeIgnores?: string[];
  ignoredSnapshot?: Record<string, string>;
}

const operations = {
  exists: existsSync, update: svnUpdate, merge: svnMerge,
  resolve: svnResolve, status: svnReadStatusAsync as (path: string) => StatusEntry[] | Promise<StatusEntry[]>, commit: svnCommit,
  merged: svnMergedRevisions,
};

export interface MergeTarget { branch: string; path: string; revisions?: string[] }

export async function checkWorkspaces(
  targets: MergeTarget[], concurrency = DEFAULT_CONCURRENCY, onProgress: ProgressCallback = () => {}, readStatus = svnReadStatusAsync,
): Promise<string[]> {
  const issues = await mapConcurrent(targets, concurrency, async (target, index) => {
    onProgress(index, '读取工作副本状态');
    try {
      const ignores = loadMergeIgnores(target.path);
      const dirty = dirtyEntries(await readStatus(target.path)).filter(entry => !isMergeIgnored(entry.path, ignores));
      onProgress(index, dirty.length ? '存在本地修改，需处理' : '检查通过', { status: dirty.length ? 'error' : 'success' });
      return dirty.length ? `${target.branch}: 工作副本不干净，请先处理\n` + dirty.map(entry => `  ${entry.text}${entry.property} ${entry.path}`).join('\n') : '';
    } catch (error) {
      onProgress(index, String(error), { status: 'error' });
      return target.branch + ': ' + String(error);
    }
  });
  return issues.filter(Boolean);
}

export function requestedRevisions(args: string[]): string[] {
  if (args[0] === '-c' && /^\d+(,\d+)*$/.test(args[1])) return [...new Set(args[1].split(','))];
  if (args[0] === '-r' && /^\d+:\d+$/.test(args[1])) {
    const [start, end] = args[1].split(':').map(Number);
    if (end > start && end - start <= 100000) return Array.from({ length: end - start }, (_, index) => String(start + index + 1));
  }
  throw new Error('仅支持正向数字版本合并');
}

export function readConcurrency(args: string[]): number {
  const index = args.findIndex(arg => arg === '--concurrency' || arg.startsWith('--concurrency='));
  if (index === -1) return DEFAULT_CONCURRENCY;
  const value = args[index].includes('=') ? args[index].split('=')[1] : args[index + 1];
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('--concurrency 必须是正整数');
  return count;
}

export async function mergeBranches(
  targets: MergeTarget[], sourceUrl: string, revisions: string[], concurrency: number,
  onProgress: (index: number, line: string, result?: MergeResult) => void,
  run: typeof mergeBranch = mergeBranch,
): Promise<MergeResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数');
  validateMergeTargets(targets);
  return mapConcurrent(targets, concurrency, async ({ branch, path, revisions: targetRevisions }, index) => {
    onProgress(index, '正在检查工作副本');
    let result: MergeResult;
    try {
      result = targetRevisions?.length === 0
        ? { branch, path, status: 'unchanged', changes: [], conflicts: [], revisions: [], message: '没有待合并版本' }
        : await run(branch, path, sourceUrl, targetRevisions ? ['-c', targetRevisions.join(',')] : revisions, line => onProgress(index, line));
    } catch (error) {
      result = { branch, path, status: 'error', changes: [], conflicts: [], message: String(error) };
    }
    const labels: Record<MergeResult['status'], string> = {
      ready: '合并完成，待提交', unchanged: '无变更', conflict: '仍有冲突', error: '失败', committed: '已提交',
    };
    onProgress(index, `${labels[result.status]}${result.message ? `：${result.message}` : ''}（冲突记录 ${result.conflicts.length}）`, result);
    return result;
  });
}

export async function mergeBranch(
  branch: string, path: string, sourceUrl: string, revisions: string[],
  onLine: (line: string) => void, overrides: Partial<typeof operations> = {},
): Promise<MergeResult> {
  const ops = { ...operations, ...overrides };
  const result: MergeResult = { branch, path, status: 'error', changes: [], conflicts: [] };
  const touchedIgnored = new Set<string>();
  const recordLine = (line: string) => {
    // SVN update/merge notifications have four status columns followed by a path.
    if (/^[ ADUGCEBR]{4} /.test(line) && /[ADUGCEBR]/.test(line.slice(0, 4))) {
      const notified = line.slice(5).trim();
      for (const ignored of Object.keys(result.ignoredSnapshot ?? {})) {
        if (pathKey(notified) === ignored || (('ADR'.includes(line[0]) || line[3] === 'C') && containsPath(notified, ignored))) touchedIgnored.add(ignored);
      }
    }
    onLine(line);
  };
  // Resolve only newly encountered conflicts, never pre-existing conflicts.
  const resolveConflicts = async () => {
    await revertMergeIgnores(path, result.mergeIgnores ?? [], await ops.status(path), onLine);
    for (const changed of await changedIgnored(result.ignoredSnapshot ?? {})) touchedIgnored.add(changed);
    const conflicts = (await ops.status(path)).filter(isConflict);
    for (const entry of conflicts) {
      if (entry.changelist === ignoredChangelist || pathKey(entry.path) in (result.ignoredSnapshot ?? {})) touchedIgnored.add(pathKey(entry.path));
    }
    for (const protectedPath of touchedIgnored) {
      if (!result.conflicts.some(entry => pathKey(entry.path) === protectedPath)) {
        result.conflicts.push({ path: protectedPath, tree: false, resolution: 'unresolved', reason: 'ignore-on-commit 文件被更新或合并触碰，需人工处理' });
      }
    }
    for (const entry of conflicts) {
      if (touchedIgnored.has(pathKey(entry.path))) continue;
      const detail: ConflictResult = { path: entry.path, tree: entry.treeConflict, resolution: 'unresolved' };
      result.conflicts.push(detail);
      onLine(`解决${detail.tree ? '树' : '普通'}冲突: ${entry.path} (theirs-full)`);
      await ops.resolve(entry.path, 'theirs-full', onLine);
      let remaining = (await ops.status(path)).find(item => item.path === entry.path && isConflict(item));
      if (!remaining) {
        detail.resolution = 'theirs-full';
      } else if (remaining.treeConflict && remaining.text !== 'C' && remaining.property !== 'C') {
        onLine(`树冲突回退: ${entry.path} (accept working，保留工作副本状态)`);
        await ops.resolve(entry.path, 'working', onLine);
        remaining = (await ops.status(path)).find(item => item.path === entry.path && isConflict(item));
        if (!remaining) detail.resolution = 'working';
      }
    }
    const state = await ops.status(path);
    result.changes = state.filter(entry => isChange(entry) && !isMergeIgnored(entry.path, result.mergeIgnores ?? []) && entry.changelist !== ignoredChangelist && !(pathKey(entry.path) in (result.ignoredSnapshot ?? {})));
    return state.some(isConflict) || touchedIgnored.size > 0;
  };
  try {
    if (!path || !ops.exists(path)) throw new Error(`路径不存在: ${path}`);
    result.mergeIgnores = loadMergeIgnores(path);
    const initialState = await ops.status(path);
    const initial = initialState.filter(entry => !isMergeIgnored(entry.path, result.mergeIgnores!));
    const existing = initial.filter(isConflict);
    if (existing.length) {
      result.conflicts = existing.map(entry => ({ path: entry.path, tree: entry.treeConflict, resolution: 'unresolved' }));
      result.status = 'conflict';
      result.message = '已有冲突，跳过更新和合并';
      return result;
    }
    const dirty = dirtyEntries(initial);
    if (dirty.length) throw new Error('工作副本不干净，请先处理:\n' + dirty.map(entry => entry.path).join('\n'));
    result.ignoredSnapshot = await snapshotIgnored(initialState);
    await revertMergeIgnores(path, result.mergeIgnores, initialState, onLine);
    onLine(`svn update ${path}`);
    const updated = await ops.update(path, recordLine);
    const updateConflicts = await resolveConflicts();
    if (!updated) throw new Error('update 失败，保留现场，不提交');
    if (updateConflicts) {
      result.status = 'conflict';
      result.message = '更新冲突未解决，未执行合并';
      return result;
    }
    const requested = requestedRevisions(revisions);
    const alreadyMerged = await ops.merged(sourceUrl, path, requested);
    result.revisions = requested.filter(revision => !alreadyMerged.has(revision));
    result.skippedRevisions = requested.filter(revision => alreadyMerged.has(revision));
    if (!result.revisions.length) {
      result.status = 'unchanged';
      result.message = '所选版本均已合并，跳过合并及提交';
      return result;
    }
    // Full merges can contain thousands of revisions; keep each command bounded.
    const batchSize = result.mergeIgnores.length ? 1 : 100;
    for (let offset = 0; offset < result.revisions.length; offset += batchSize) {
      const filteredArgs = ['-c', result.revisions.slice(offset, offset + batchSize).join(',')];
      onLine(`svn merge ${filteredArgs.join(' ')} ${sourceUrl}`);
      const merged = await ops.merge(sourceUrl, filteredArgs, path, recordLine);
      const unresolved = await resolveConflicts();
      if (!merged) throw new Error('merge 失败，可能仅部分合并，不提交');
      if (unresolved) { result.status = 'conflict'; return result; }
    }
    result.status = result.changes.length ? 'ready' : 'unchanged';
  } catch (error) {
    result.status = 'error';
    result.message = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export function formatCommitMessage(source: string, entries: LogEntry[]): string {
  if (!entries.length) throw new Error('无法生成提交信息：没有版本日志');
  const sorted = [...entries].sort((a, b) => Number(a.rev) - Number(b.rev));
  return `Merged revision(s) ${sorted.map(entry => entry.rev).join(', ')} from ${source}:\n`
    + sorted.map(entry => entry.msg).join('\n........\n') + '\n........';
}

export function formatMergeSummary(source: string, revisions: string, results: MergeResult[], time = new Date().toISOString()): string {
  const labels: Record<MergeResult['status'], string> = {
    ready: '待提交', unchanged: '无变更', conflict: '冲突未解决', error: '失败', committed: '已提交',
  };
  const lines = ['合并汇总（尚未提交）', `源分支: ${source}`, `版本: ${revisions}`, `时间: ${time}`];
  const headers = ['目标分支', '状态', '变更', '新增', '修改', '删除', '替换', '属性', '冲突'];
  const rows = results.map(result => {
    const count = (text: string) => result.changes.filter(entry => entry.text === text).length;
    return [result.branch, labels[result.status], result.changes.length,
      count('A'), count('M'), count('D'), count('R'),
      result.changes.filter(entry => entry.property === 'M').length, result.conflicts.length,
    ].map(String);
  });
  const widths = headers.map((header, index) => Math.max(stringWidth(header), ...rows.map(row => stringWidth(row[index]))));
  const formatRow = (row: string[], numeric: boolean) => '  ' + row.map((cell, index) => {
    const space = ' '.repeat(widths[index] - stringWidth(cell));
    return numeric && index >= 2 ? space + cell : cell + space;
  }).join('   ');
  const separator = '  ' + widths.map(width => '─'.repeat(width)).join('   ');
  lines.push('', formatRow(headers, false), separator);
  for (const row of rows) lines.push(formatRow(row, true), '');
  lines.push(separator);
  if (results.some(result => result.revisions || result.skippedRevisions)) {
    lines.push('', '各分支本次合并 revision:');
    for (const result of results) {
      const versions = result.revisions?.map(revision => `r${revision}`).join(', ') || '无';
      const incomplete = result.revisions?.length && ['error', 'conflict'].includes(result.status);
      lines.push(`  ${result.branch}: ${versions}${incomplete ? '（未完成，需检查）' : ''}`);
    }
  }
  const details = results.filter(result => result.message || result.conflicts.length);
  if (details.length) lines.push('', '异常与冲突详情:');
  for (const result of details) {
    lines.push(`\n  ${result.branch} (${result.path})`);
    if (result.message) lines.push(`  ${result.message}`);
    for (const conflict of result.conflicts) {
      lines.push(`  ${conflict.tree ? '树' : '普通'}冲突: ${conflict.path} → ${conflict.resolution === 'unresolved' ? '未解决' : conflict.resolution}${conflict.reason ? `（${conflict.reason}）` : ''}`);
    }
  }
  lines.push(`\n统计：待提交 ${results.filter(r => r.status === 'ready').length}，无变更 ${results.filter(r => r.status === 'unchanged').length}，发生冲突 ${results.filter(r => r.conflicts.length > 0 || r.status === 'conflict').length}，失败 ${results.filter(r => r.status === 'error').length}`);
  return lines.join('\n');
}

export function requiresConfirmation(results: MergeResult[], skipConfirmation: boolean): boolean {
  return !skipConfirmation || results.some(result => result.conflicts.length > 0 || result.status === 'conflict' || result.status === 'error');
}

/** The caller displays the complete summary before entering this commit phase. */
export async function commitAfterSummary(
  results: MergeResult[], message: string, skipConfirmation: boolean,
  confirm: () => Promise<boolean>, onLine: (line: string) => void, overrides: Partial<typeof operations> = {},
  concurrency = DEFAULT_CONCURRENCY,
  showProgress: (run: (update: ProgressCallback) => Promise<void>) => Promise<void> = run => run((_index, line) => onLine(line)),
): Promise<boolean> {
  const ops = { ...operations, ...overrides };
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数');
  const checkProtected = async (result: MergeResult, report = onLine) => {
    const changed = await changedIgnored(result.ignoredSnapshot ?? {});
    for (const path of changed) {
      if (!result.conflicts.some(conflict => pathKey(conflict.path) === path)) {
        result.conflicts.push({ path, tree: false, resolution: 'unresolved', reason: 'ignore-on-commit 文件在合并后变化，需人工处理' });
      }
    }
    if (changed.length) {
      result.status = 'conflict';
      result.message = 'ignore-on-commit 文件发生变化，不自动提交';
      report(`${result.branch}: ${result.message}\n${changed.join('\n')}`);
    }
    return changed.length > 0;
  };
  for (const result of results.filter(result => result.status === 'ready')) await checkProtected(result);
  if (requiresConfirmation(results, skipConfirmation) && !await confirm()) return false;
  await showProgress(async update => {
    await mapConcurrent(results, concurrency, async (result, index) => {
      const report = (line: string) => update(index, line);
      if (result.status !== 'ready') {
        update(index, result.message ?? (result.status === 'unchanged' ? '无变更，跳过提交' : '合并异常，跳过提交'), result);
        return;
      }
      report('正在检查提交状态');
      try {
        // Recheck after the user has inspected the working copies.
        if (await checkProtected(result, report)) return;
        const commitIgnores = [...(result.mergeIgnores ?? []), ...loadMergeIgnores(result.path)];
        result.mergeIgnores = commitIgnores;
        await revertMergeIgnores(result.path, commitIgnores, await ops.status(result.path), report);
        const state = await ops.status(result.path);
        if (state.some(isConflict)) {
          result.status = 'conflict';
          result.message = '提交前检测到未解决冲突，跳过提交';
          report(`${result.branch}: ${result.message}`);
          return;
        }
        const changes = state.filter(entry => isChange(entry) && !isMergeIgnored(entry.path, result.mergeIgnores ?? []) && entry.changelist !== ignoredChangelist && !(pathKey(entry.path) in (result.ignoredSnapshot ?? {})));
        const planned = new Set(result.changes.map(entry => pathKey(entry.path)));
        if (changes.some(entry => !planned.has(pathKey(entry.path)))) throw new Error('提交前发现计划外本地修改，请先处理');
        const ignored = [...(result.mergeIgnores ?? []), ...Object.keys(result.ignoredSnapshot ?? {}), ...state.filter(entry => entry.changelist === ignoredChangelist).map(entry => entry.path)];
        if (changes.some(entry => 'ADR'.includes(entry.text) && ignored.some(path => containsPath(entry.path, path)))) {
          throw new Error('目录结构变更包含 ignore-on-commit 文件，需人工处理');
        }
        if (!changes.length) {
          result.status = 'unchanged';
          result.message = '没有可提交变更（已排除 ignore-on-commit）';
          return;
        }
        report(`${result.branch}: svn commit`);
        const ok = await ops.commit(result.path, result.commitMessage ?? message, report, changes.map(entry => entry.path));
        result.status = ok ? 'committed' : 'error';
        result.message = ok ? '提交成功' : '提交失败，保留工作副本变更';
        report(`${result.branch}: ${result.message}`);
      } catch (error) {
        result.status = 'error';
        result.message = String(error);
        report(`${result.branch}: ${result.message}`);
      } finally {
        update(index, result.message ?? '提交结束', result);
      }
    });
  });
  return true;
}

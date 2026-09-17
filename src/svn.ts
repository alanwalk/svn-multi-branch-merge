import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { LogEntry } from './types.js';
import { createSvnLineReader, decodeSvnOutput } from './encoding.js';

// ── low-level ─────────────────────────────────────────────────────────

/** Run an SVN command, stream each output line to `onLine`. Returns true on exit 0. */
export function svnExec(
  args: string[],
  onLine: (line: string) => void,
): Promise<boolean> {
  return new Promise(resolve => {
    // stdout/stderr must not share partial lines or multibyte characters.
    const stdout = createSvnLineReader(onLine);
    const stderr = createSvnLineReader(onLine);

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('svn', args);
    } catch {
      onLine('[错误] 找不到 svn 命令，请确认已安装并在 PATH 中');
      resolve(false);
      return;
    }

    proc.stdout?.on('data', (d: Buffer) => stdout.write(d));
    proc.stderr?.on('data', (d: Buffer) => stderr.write(d));
    proc.on('close', (code: number | null) => {
      stdout.end();
      stderr.end();
      resolve(code === 0);
    });
    proc.on('error', () => {
      onLine('[错误] 找不到 svn 命令，请确认已安装并在 PATH 中');
      resolve(false);
    });
  });
}

/** Run a quick SVN command silently. Returns stdout or null on failure. */
function svnSilent(args: string[]): string | null {
  const r = spawnSync('svn', args, { timeout: 30_000 });
  if (r.status !== 0) return null;
  return decodeSvnOutput(r.stdout as Buffer);
}

// ── high-level ────────────────────────────────────────────────────────

export function svnGetUrl(localPath: string): string | null {
  return svnSilent(['info', localPath, '--show-item', 'url'])?.trim() ?? null;
}

export function svnFetchLog(localPath: string, limit = 30): string | null {
  return svnSilent(['log', '--xml', '--non-interactive', localPath, '--limit', String(limit), '-r', 'HEAD:1']);
}

export function parseLog(text: string): LogEntry[] {
  if (XMLValidator.validate(text) !== true) throw new Error('SVN 日志 XML 无效');
  const parsed = new XMLParser({
    ignoreAttributes: false, parseTagValue: false, trimValues: false,
    isArray: name => name === 'logentry',
  }).parse(text);
  if (!Object.hasOwn(parsed, 'log')) throw new Error('SVN 日志缺少 log 节点');
  return (parsed.log?.logentry ?? []).map((entry: Record<string, string>) => ({
    rev: entry['@_revision'], author: entry.author ?? '', date: (entry.date ?? '').slice(0, 10), msg: entry.msg ?? '',
  }));
}

export function svnGetSourceName(path: string): string {
  const relativeUrl = svnSilent(['info', path, '--show-item', 'relative-url'])?.trim();
  if (!relativeUrl?.startsWith('^/')) throw new Error('无法获取源分支仓库路径');
  return decodeURIComponent(relativeUrl.slice(2));
}

export function svnFetchRevisionLogs(sourceUrl: string, revArgs: string[]): LogEntry[] {
  const [flag, value] = revArgs;
  let args = revArgs;
  if (flag === '-r') {
    const [start, end] = value.split(':').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < 0 || start === end) {
      throw new Error('请输入有效的数字版本范围');
    }
    // svn log includes both endpoints; svn merge excludes the starting revision.
    args = ['-r', start < end ? `${start + 1}:${end}` : `${start}:${end + 1}`];
  }
  const output = svnSilent(['log', '--xml', '--non-interactive', ...args, sourceUrl]);
  if (output === null) throw new Error('无法读取所选版本的完整日志，已停止执行');
  const entries = parseLog(output);
  if (!entries.length) throw new Error('所选版本没有源分支日志，已停止执行');
  if (flag === '-c' && value.split(',').some(rev => !entries.some(entry => entry.rev === rev.trim()))) {
    throw new Error('部分所选版本的日志缺失，已停止执行');
  }
  return entries;
}

export function svnStatus(path: string): string {
  const output = svnSilent(['status', '--ignore-externals', path]);
  if (output === null) throw new Error(`无法读取 SVN 状态: ${path}`);
  return output;
}

export interface StatusEntry {
  path: string;
  text: string;
  property: string;
  treeConflict: boolean;
  changelist?: string;
}

export function parseStatus(output: string): StatusEntry[] {
  return output.split(/\r?\n/)
    .filter(line => /^[ ACDIMRX?!~][ CM][ L][ +][ SX][ KOTB][ C] /.test(line))
    .map(line => ({ path: line.slice(8), text: line[0], property: line[1], treeConflict: line[6] === 'C' }));
}

export function isConflict(entry: StatusEntry): boolean {
  return entry.text === 'C' || entry.property === 'C' || entry.treeConflict;
}

export function isChange(entry: StatusEntry): boolean {
  return 'MADRC!~'.includes(entry.text) || 'MC'.includes(entry.property) || entry.treeConflict;
}

export const svnReadStatus = (path: string) => parseStatus(svnStatus(path));

export async function svnReadStatusAsync(path: string): Promise<StatusEntry[]> {
  const ordinary = parseStatusXml(await svnCapture(['status', '--xml', '--ignore-externals', path]));
  // Include clean changelist members too: an incoming change must not silently commit them.
  const ignored = parseStatusXml(await svnCapture(['status', '--xml', '--verbose', '--ignore-externals', '--changelist', 'ignore-on-commit', path]));
  return [...new Map([...ordinary, ...ignored].map(entry => [entry.path, entry])).values()];
}

export async function svnCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const child = spawn('svn', args);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0
      ? resolve(decodeSvnOutput(Buffer.concat(stdout)))
      : reject(new Error(`svn ${args[0]} 失败: ${decodeSvnOutput(Buffer.concat(stderr))}`)));
  });
}

export function parseStatusXml(xml: string): StatusEntry[] {
  if (XMLValidator.validate(xml) !== true) throw new Error('SVN status XML 无效');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false,
    isArray: name => ['target', 'entry', 'changelist'].includes(name),
  }).parse(xml);
  if (!parsed.status) throw new Error('SVN status 节点缺失');
  const codes: Record<string, string> = { normal: ' ', none: ' ', modified: 'M', added: 'A', deleted: 'D', replaced: 'R',
    conflicted: 'C', missing: '!', obstructed: '~', unversioned: '?', ignored: 'I', external: 'X', incomplete: '!' };
  const entries: StatusEntry[] = [];
  interface StatusNode {
    entry?: Array<{ '@_path': string; 'wc-status'?: Record<string, string> }>;
    target?: StatusNode[];
    changelist?: Array<StatusNode & { '@_name': string }>;
  }
  const visit = (node: StatusNode, changelist?: string) => {
    for (const entry of node.entry ?? []) {
      const state = entry['wc-status'];
      if (!state) continue;
      entries.push({ path: entry['@_path'], text: codes[state['@_item']] ?? '~',
        property: codes[state['@_props']] ?? ' ', treeConflict: state['@_tree-conflicted'] === 'true', changelist });
    }
    for (const target of node.target ?? []) visit(target, changelist);
    for (const list of node.changelist ?? []) visit(list, list['@_name']);
  };
  visit(parsed.status);
  return entries;
}

export async function svnMergedRevisions(source: string, target: string, revisions: string[]): Promise<Set<string>> {
  if (!revisions.length) return new Set();
  const sorted = [...revisions].sort((a, b) => Number(a) - Number(b));
  const query = (kind: string, depth: string) => svnCapture(['mergeinfo', '--non-interactive', '--show-revs', kind, '--depth', depth,
    '-r', `${sorted[0]}:${sorted.at(-1)}`, source, target]);
  const [merged, eligible] = await Promise.all([query('merged', 'empty'), query('eligible', 'infinity')]);
  // Require branch-root merge evidence; recursive 'merged' can contain subtree-only merges.
  const pending = new Set(eligible.split(/\r?\n/).map(line => /^r(\d+)\*?$/.exec(line.trim())?.[1]).filter(Boolean));
  return new Set(merged.split(/\r?\n/).filter(line => /^r\d+$/.test(line.trim()))
    .map(line => line.trim().slice(1)).filter(revision => !pending.has(revision)));
}

export async function svnEligibleRevisions(source: string, target: string, head: string): Promise<string[]> {
  const outputs = await Promise.all(['empty', 'infinity'].map(depth => svnCapture([
    'mergeinfo', '--non-interactive', '--show-revs', 'eligible', '--depth', depth, '-r', `1:${head}`, source, target,
  ])));
  return [...new Set(outputs.flatMap(output => output.split(/\r?\n/)
    .map(line => /^r(\d+)\*?$/.exec(line.trim())?.[1]).filter((value): value is string => Boolean(value))))]
    .sort((a, b) => Number(a) - Number(b));
}

export async function svnLogsForRevisions(source: string, revisions: string[]): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  // Bounded argument length and XML size, including selections older than the recent list.
  for (let index = 0; index < revisions.length; index += 100) {
    const group = revisions.slice(index, index + 100);
    entries.push(...parseLog(await svnCapture(['log', '--xml', '--non-interactive', '-c', group.join(','), source])));
  }
  return [...new Map(entries.map(entry => [entry.rev, entry])).values()].sort((a, b) => Number(a.rev) - Number(b.rev));
}

export const svnUpdate = (path: string, onLine: (l: string) => void) =>
  svnExec(['update', '--non-interactive', '--accept', 'postpone', path], onLine);

export const svnMerge = (srcUrl: string, revArgs: string[], tgtPath: string, onLine: (l: string) => void) =>
  svnExec(['merge', '--non-interactive', '--accept', 'postpone', ...revArgs, srcUrl, tgtPath], onLine);

export const svnResolve = (path: string, accept: 'theirs-full' | 'working', onLine: (l: string) => void) =>
  svnExec(['resolve', '--non-interactive', '--accept', accept, '--depth', 'empty', '--', `${path}@`], onLine);

export async function svnCommit(path: string, message: string, onLine: (l: string) => void, targets?: string[]): Promise<boolean> {
  const directory = mkdtempSync(join(tmpdir(), 'svn-merge-message-'));
  const file = join(directory, 'message.txt');
  const targetsFile = join(directory, 'targets.txt');
  try {
    if (targets?.length === 0) return true;
    writeFileSync(file, message, 'utf8');
    if (targets) {
      if (targets.some(target => /[\r\n]/.test(target))) throw new Error('提交路径包含换行，无法安全提交');
      writeFileSync(targetsFile, targets.map(target => `${target}@`).join('\n'), 'utf8');
    }
    return await svnExec(['commit', ...(targets ? ['--targets', targetsFile, '--depth', 'empty'] : [path]),
      '--file', file, '--encoding', 'UTF-8', '--keep-changelists'], onLine);
  } finally {
    for (const temporary of [file, targetsFile]) {
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  }
}

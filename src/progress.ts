import { stripVTControlCharacters } from 'node:util';
import { createLogUpdate } from 'log-update';
import cliTruncate from 'cli-truncate';
export type ProgressCallback = (index: number, line: string, result?: { status: string }) => void;

export interface BranchProgress {
  branch: string;
  latest: string;
  running: boolean;
  result?: { status: string };
}

export function formatProgress(items: BranchProgress[], columns: number, rows: number, phase = '合并'): string {
  const completed = items.filter(item => item.result).length;
  const active = items.filter(item => item.running).length;
  const capacity = Math.max(1, rows - 3);
  // Keep active branches visible in short terminals; final summary contains all branches.
  const visible = items.length <= capacity ? items : [
    ...items.filter(item => item.running),
    ...items.filter(item => !item.running && !item.result),
    ...items.filter(item => item.result),
  ].slice(0, capacity);
  const lines = [`${phase}进度 ${completed}/${items.length} · 进行中 ${active}`];
  for (const item of visible) {
    const icon = item.result ? (['error', 'conflict'].includes(item.result.status) ? '!' : '✓') : item.running ? '›' : '·';
    lines.push(`${icon} ${item.branch}  ${item.latest}`);
  }
  if (visible.length < items.length) lines.push(`另有 ${items.length - visible.length} 个分支，结束后查看完整汇总`);
  return lines.map(line => cliTruncate(
    stripVTControlCharacters(line).replace(/[\r\n\t]/g, ' '), Math.max(1, columns - 1),
  )).join('\n');
}

export function createBranchProgress(branches: string[], phase: string) {
  let items: BranchProgress[] = branches.map(branch => ({ branch, latest: '等待开始', running: false }));
  const tty = Boolean(process.stdout.isTTY);
  const render = tty ? createLogUpdate(process.stdout) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => render?.(formatProgress(items, process.stdout.columns || 80, process.stdout.rows || 24, phase));
  draw();
  return {
    setPhase(nextPhase: string) {
      phase = nextPhase;
      items = branches.map(branch => ({ branch, latest: `等待${phase}`, running: false }));
      draw();
    },
    update(index: number, line: string, result?: { status: string }) {
      items[index] = { branch: branches[index], latest: line, running: !result, result };
      if (!tty) return;
      // Collapse bursts of SVN file notifications into a single redraw.
      if (!timer) timer = setTimeout(() => { timer = undefined; draw(); }, 80);
    },
    finish() {
      if (timer) clearTimeout(timer);
      draw();
      render?.done();
      if (!tty) console.log(formatProgress(items, 160, items.length + 3, phase));
    },
  };
}

export async function withBranchProgress<T>(branches: string[], phase: string, run: (update: ProgressCallback) => Promise<T>): Promise<T> {
  const progress = createBranchProgress(branches, phase);
  try { return await run(progress.update); }
  finally { progress.finish(); }
}

import type { Config } from './types.js';
import { parseRevisionInput } from './revisions.js';
import { readConcurrency } from './merger.js';
import { downstreamChoices } from './branch-select.js';

export function parseArguments(args: string[], config: Config) {
  const positional: string[] = [];
  let skipConfirmation = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--skip-summary-confirm') skipConfirmation = true;
    else if (arg === '--concurrency') {
      if (!/^\d+$/.test(args[++index] ?? '')) throw new Error('--concurrency 必须是正整数');
    } else if (arg.startsWith('--concurrency=')) {
      if (!/^\d+$/.test(arg.slice('--concurrency='.length))) throw new Error('--concurrency 必须是正整数');
    } else if (arg.startsWith('-')) throw new Error(`未知参数: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error('用法: svnmbm <源分支> ["待合并 revision"]，含空格的版本参数请加引号');
  const source = positional[0];
  if (source !== undefined) {
    if (!Object.hasOwn(config.branches, source)) throw new Error(`源分支不存在: ${source}`);
    if (!downstreamChoices(config, source)[0].targets.length) throw new Error(`源分支没有已启用的一级子分支: ${source}`);
  }
  const revisions = positional.length === 2 ? parseRevisionInput(positional[1]) : undefined;
  return { source, revisions, quick: source !== undefined, concurrency: readConcurrency(args), skipConfirmation };
}

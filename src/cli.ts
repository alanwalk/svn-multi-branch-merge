import type { Config } from './types.js';
import { readFileSync } from 'node:fs';
import { parseRevisionInput } from './revisions.js';
import { readConcurrency } from './merger.js';
import { downstreamChoices } from './branch-select.js';

export function informationalOutput(args: string[]): string | undefined {
  if (args.some(arg => arg === '-h' || arg === '--help')) {
    return `svnmbm — SVN 多分支合并工具

用法:
  svnmbm                              交互选择源分支、revision 和目标
  svnmbm <源分支> [revision] [选项]    快速合并到已启用的一级子分支

选项:
  -h, --help                 显示帮助并退出
  -v, -V, --version          显示版本并退出
  --concurrency <数量>       并行数，默认 6（也支持 --concurrency=6）
  --skip-summary-confirm     跳过正常合并的汇总确认；失败或冲突仍须人工确认

revision:
  不传则全合并；支持逗号列表和包含首尾的区间，如 "12312 , 12314-12319"。
  忽略空格；冒号区间 12314:12319 不含起点；自动剔除已合并版本。

配置:
  ~/.svnmbm/config.jsonc（Windows: %USERPROFILE%\\.svnmbm\\config.jsonc）
  相对副本路径以配置文件所在目录为基准。缺少配置会报错并显示格式示例。

快速模式全部正常时自动提交；任一目标异常则整批暂停确认。
工作副本不干净时需人工处理，输入 c 才会执行清理。

示例:
  svnmbm trunk
  svnmbm trunk "1001,1003-1005" --concurrency 3`;
  }
  if (args.some(arg => ['-v', '-V', '--version'].includes(arg))) {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  }
  return undefined;
}

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

#!/usr/bin/env node
import { select, checkbox, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { loadConfig } from './config.js';
import { downstreamChoices, selectTargetBranches } from './branch-select.js';
import { svnGetUrl, svnGetSourceName, svnFetchLog, svnLogsForRevisions, svnEligibleRevisions, svnCapture, svnMergedRevisions, parseLog } from './svn.js';
import type { LogEntry } from './types.js';
import { parseRevisionInput } from './revisions.js';
import { informationalOutput, parseArguments } from './cli.js';
import { mergeBranches, checkWorkspaces, validateMergeTargets, formatMergeSummary, formatCommitMessage, commitAfterSummary } from './merger.js';
import { createBranchProgress, withBranchProgress } from './progress.js';
import { mapConcurrent } from './concurrency.js';
import { cleanWorkspaces } from './workspace.js';


function hr() { console.log(chalk.gray('─'.repeat(64))); }

// Inquirer limits rendered list lines, but does not cap them to terminal height.
// Leave room for the question, wrapped help, validation errors and cursor.
function listPageSize() {
  return Math.max(1, Math.min(20, (process.stdout.rows || 14) - 7));
}

function svnLine(line: string) {
  console.log(chalk.dim('    ' + line));
}

async function main() {
  const info = informationalOutput(process.argv.slice(2));
  if (info !== undefined) { console.log(info); return; }
  const config = loadConfig();
  const branchNames = Object.keys(config.branches).filter(branch => (config.tree[branch]?.length ?? 0) > 0);
  const options = parseArguments(process.argv.slice(2), config);
  const { concurrency } = options;
  console.log(chalk.bold.cyan('\n╔══════════════════════════════╗'));
  console.log(chalk.bold.cyan('║  SVN Multi-Branch Merge CLI  ║'));
  console.log(chalk.bold.cyan('╚══════════════════════════════╝\n'));

  // ── 1. 选择源分支 ─────────────────────────────────────────────────────
  if (!branchNames.length) {
    console.log('没有配置子节点的源分支，请检查 config.jsonc 的 tree 配置。');
    return;
  }
  const source = options.source ?? await select({
    message: '选择源分支:',
    pageSize: listPageSize(),
    choices: branchNames.map(n => ({
      value: n,
      name:  `${n}  ${chalk.dim(config.branches[n]?.local_path ?? '')}`,
    })),
  });

  const branchChoices = downstreamChoices(config, source);
  if (!branchChoices[0].targets.length) {
    console.log('当前源分支没有已启用的下游分支，请检查 config.jsonc 的 tree 配置。');
    return;
  }
  const mode = options.quick ? (options.revisions ? 'manual' : 'all') : await select({
    message: '选择合并方式:',
    choices: [
      { value: 'recent', name: '近期列表：勾选最近 30 条提交' },
      { value: 'manual', name: '手动输入：版本号、逗号列表或区间' },
      { value: 'all', name: '全合并：各目标尚未合并的全部版本' },
    ],
  });
  const srcPath = config.branches[source]?.local_path ?? '';
  let srcUrl = svnGetUrl(srcPath);
  if (!srcUrl) throw new Error('无法获取源分支 URL: ' + srcPath);
  const sourceName = svnGetSourceName(srcPath);
  let requested: string[] = [];
  let logs: LogEntry[] = [];
  let head = '';
  if (mode === 'recent') {
    const output = svnFetchLog(srcPath);
    if (!output) throw new Error('无法读取近期日志，请重试或选择手动输入');
    const entries = parseLog(output);
    if (!entries.length) { console.log('源分支没有近期提交。'); return; }
    requested = await checkbox({
      message: '选择要合并的提交:',
      choices: entries.map(entry => ({
        value: entry.rev, short: 'r' + entry.rev,
        name: chalk.yellow('r' + entry.rev.padEnd(8)) + chalk.green(entry.author.padEnd(14))
          + chalk.gray(entry.date) + '  ' + entry.msg.split(/\r?\n/)[0].slice(0, 52),
      })),
      pageSize: listPageSize(),
      validate: value => value.length > 0 || '请至少选择一个提交',
    });
    logs = entries.filter(entry => requested.includes(entry.rev));
  } else if (mode === 'manual') {
    requested = options.revisions ?? parseRevisionInput(await input({
      message: '输入 revision（如 12312 , 12314,12316 - 12319）:',
      validate: value => {
        try { parseRevisionInput(value); return true; }
        catch (error) { return String(error); }
      },
    }));
    logs = await svnLogsForRevisions(srcUrl, requested);
    const omitted = requested.filter(revision => !logs.some(entry => entry.rev === revision));
    if (omitted.length) console.log('这些版本未修改源分支，已跳过: ' + omitted.join(', '));
  } else {
    head = (await svnCapture(['info', '-r', 'HEAD', '--show-item', 'revision', srcUrl])).trim();
    if (!/^\d+$/.test(head)) throw new Error('无法确定全合并的源版本');
    srcUrl += '@' + head;
  }
  if (mode !== 'all' && !logs.length) { console.log('没有需要合并的源分支提交。'); return; }
  const revDisplay = mode === 'all' ? '全合并（截至 r' + head + '）' : logs.map(entry => 'r' + entry.rev).join(', ');

  // ── 3. 选择目标分支 ────────────────────────────────────────────────────
  const targets = options.quick ? branchChoices[0].targets : await selectTargetBranches({ choices: branchChoices, pageSize: listPageSize() });
  if (options.quick) console.log(`快速模式: ${source} → ${targets.join(', ')}；${revDisplay}`);

  // ── 4. 确认 ────────────────────────────────────────────────────────────
  const mergeTargets = targets.map(branch => ({ branch, path: config.branches[branch]?.local_path ?? '' }));
  validateMergeTargets(mergeTargets);
  // Keep consecutive preparation phases in one live progress region.
  const plans = await (async () => {
    let progress = createBranchProgress(targets, '检查');
    let finished = false;
    const finish = () => {
      if (!finished) { progress.finish(); finished = true; }
    };
    let cleanup = false;
    try {
      while (true) {
        let failures: string[] = [];
        if (cleanup) {
          progress.setPhase('清理');
          failures = await cleanWorkspaces(mergeTargets, concurrency, progress.update);
        }
        progress.setPhase('检查');
        const issues = await checkWorkspaces(mergeTargets, concurrency, progress.update);
        if (!issues.length && !failures.length) break;
        finish();
        console.log([...failures, ...issues].join('\n\n'));
        if (options.quick && !process.stdin.isTTY) throw new Error('工作副本需要人工处理，请在交互终端重新运行');
        console.log('输入 c 将清理所有已选目标副本：revert 本地改动，删除未跟踪项；保留 ignore-on-commit。');
        const action = (await input({
          message: 'y 重新检查 / c 清理并重查 / n 退出:',
          default: 'n',
          validate: value => /^[ycn]$/i.test(value.trim()) || '请输入 y、c 或 n',
        })).trim().toLowerCase();
        if (action === 'n') return;
        cleanup = action === 'c';
        progress = createBranchProgress(targets, cleanup ? '清理' : '检查');
        finished = false;
      }
      progress.setPhase('版本检查');
      return await mapConcurrent(mergeTargets, concurrency, async (target, index) => {
        progress.update(index, '查询待合并版本');
        try {
          const merged = mode === 'all' ? new Set<string>() : await svnMergedRevisions(srcUrl, target.path, logs.map(entry => entry.rev));
          const revisions = mode === 'all' ? await svnEligibleRevisions(srcUrl, target.path, head) : logs.filter(entry => !merged.has(entry.rev)).map(entry => entry.rev);
          progress.update(index, '待合并 ' + revisions.length + ' 个版本', { status: 'success' });
          return { ...target, revisions, skipped: logs.filter(entry => merged.has(entry.rev)).map(entry => entry.rev) };
        } catch (error) {
          progress.update(index, '版本检查失败: ' + String(error), { status: 'error' });
          throw error;
        }
      });
    } finally { finish(); }
  })();
  if (!plans) return;
  if (mode === 'all') {
    const revisions = [...new Set(plans.flatMap(plan => plan.revisions))].sort((a, b) => Number(a) - Number(b));
    console.log('读取待合并版本的完整日志（' + revisions.length + ' 个版本）...');
    logs = await svnLogsForRevisions(srcUrl, revisions);
    if (revisions.some(revision => !logs.some(entry => entry.rev === revision))) throw new Error('全合并日志不完整，已停止');
  }

  console.log();
  console.log(chalk.bold('执行计划:'));
  console.log(`  源分支:   ${chalk.cyan(source)}`);
  console.log(`  版本:     ${chalk.yellow(revDisplay)}`);
  console.log(`  目标:     ${targets.map(t => chalk.green(t)).join('  ')}`);
  console.log(`  并发数:   ${concurrency}`);
  for (const plan of plans) {
    console.log(`  ${plan.branch}: 待合并 ${plan.revisions.join(', ') || '无'}；已合并剔除 ${plan.skipped.join(', ') || '无'}`);
  }
  if (plans.every(plan => !plan.revisions.length)) {
    console.log('所选版本在所有目标分支均已合并，无需执行。');
    return;
  }
  console.log();

  const confirmed = options.quick || await confirm({ message: '确认执行？', default: true });
  if (!confirmed) { console.log('已取消'); process.exit(0); }

  // Merge all branches before presenting one summary and committing.
  const results = await withBranchProgress(targets, '合并', update =>
    mergeBranches(mode === 'all' ? plans : mergeTargets, srcUrl, ['-c', logs.map(entry => entry.rev).join(',')], concurrency, update));

  hr();
  for (const result of results) {
    if (result.revisions?.length) result.commitMessage = formatCommitMessage(sourceName, logs.filter(entry => result.revisions!.includes(entry.rev)));
  }
  console.log(formatMergeSummary(source, revDisplay, results));
  const proceeded = await commitAfterSummary(
    results, '', options.skipConfirmation,
    () => {
      if (options.quick && !process.stdin.isTTY) throw new Error('提交需要人工确认；请在交互终端运行，或使用 -C 在全部正常时自动提交。所有尚未提交的变更已保留');
      return confirm({ message: '确认以上合并汇总，继续提交可提交的分支？', default: false });
    },
    svnLine, {}, concurrency,
    run => withBranchProgress(targets, '提交', run),
  );
  if (!proceeded) {
    console.log('已取消提交，所有合并变更保留在工作副本中。');
    return;
  }
  hr();
  console.log('提交结果:');
  for (const result of results) {
    console.log('  ' + result.branch + ': ' + (result.message ?? (
      result.status === 'unchanged' ? '无变更，跳过提交' : '存在未解决冲突，未提交'
    )));
  }
  if (results.some(result => result.status === 'error' || result.status === 'conflict')) {
    process.exitCode = 1;
  }
}

main().catch(e => {
  if (e?.name === 'ExitPromptError') { console.log('\n已退出'); process.exit(0); }
  console.error(chalk.red('\n[错误]'), e instanceof Error ? e.message : e);
  process.exit(1);
});

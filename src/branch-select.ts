import { createPrompt, useState, useKeypress, usePagination, isUpKey, isDownKey, isSpaceKey, isEnterKey } from '@inquirer/core';
import chalk from 'chalk';
import type { Config } from './types.js';

export interface BranchChoice {
  branch: string;
  depth: number;
  path: string;
  enabled: boolean;
  targets: string[];
}

export function downstreamChoices(config: Config, source: string): BranchChoice[] {
  const makeChoice = (branch: string, depth: number): BranchChoice => {
    const cfg = config.branches[branch];
    if (!cfg) throw new Error(`分支树引用了未配置的分支: ${branch}`);
    return { branch, depth, path: cfg.local_path, enabled: cfg.enabled, targets: depth && cfg.enabled ? [branch] : [] };
  };
  const root = makeChoice(source, 0);
  const children = [...new Set(config.tree[source] ?? [])].map(branch => {
    if (branch === source) throw new Error(`分支树存在循环: ${branch}`);
    return makeChoice(branch, 1);
  });
  // Only direct children are targets; deeper descendants belong to another merge.
  root.targets = children.flatMap(child => child.targets);
  return [root, ...children];
}

export function toggleBranch(selected: string[], node: BranchChoice): string[] {
  const next = new Set(selected);
  const remove = node.targets.every(branch => next.has(branch));
  for (const branch of node.targets) {
    if (remove) next.delete(branch);
    else next.add(branch);
  }
  return [...next];
}

export const selectTargetBranches = createPrompt<string[], { choices: BranchChoice[]; pageSize: number }>((config, done) => {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const all = config.choices[0].targets;
  useKeypress(key => {
    if (isEnterKey(key)) {
      if (!selected.length) { setError('请至少选择一个目标分支'); return; }
      setFinished(true);
      done(all.filter(branch => selected.includes(branch)));
    } else if (isUpKey(key) || isDownKey(key)) {
      const step = isUpKey(key) ? -1 : 1;
      let next = active;
      do { next = (next + step + config.choices.length) % config.choices.length; }
      while (!config.choices[next].targets.length && next !== active);
      setActive(next);
    } else if (isSpaceKey(key) || key.name === 'a') {
      setSelected(toggleBranch(selected, config.choices[key.name === 'a' ? 0 : active]));
      setError('');
    } else if (key.name === 'i') {
      setSelected(all.filter(branch => !selected.includes(branch)));
      setError('');
    }
  });
  const page = usePagination({
    items: config.choices, active, pageSize: config.pageSize, loop: false,
    renderItem: ({ item, isActive }) => {
      const count = item.targets.filter(branch => selected.includes(branch)).length;
      const check = count === 0 ? '[ ]' : count === item.targets.length ? '[x]' : '[-]';
      const indent = item.depth ? '  '.repeat(item.depth - 1) + '└─ ' : '';
      const suffix = item.depth === 0 ? '（全选 / 取消全选一级目标）' : !item.enabled ? '（本分支禁用）' : '';
      const line = `${isActive ? '›' : ' '} ${check} ${indent}${item.branch} ${suffix} ${item.depth ? item.path : ''}`;
      return !item.targets.length ? chalk.dim(line) : isActive ? chalk.cyan(line) : line;
    },
  });
  if (finished) return `✔ 选择目标分支: ${all.filter(branch => selected.includes(branch)).join(', ')}`;
  return ['? 选择目标分支:', page, '', '↑↓ 移动 · 空格 选择 · a 全选 · i 反选 · Enter 确认', error ? chalk.red(error) : ''].filter(Boolean).join('\n');
});

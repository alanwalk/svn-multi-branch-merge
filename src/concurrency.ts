import { existsSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

export const DEFAULT_CONCURRENCY = 6;

export async function mapConcurrent<T, R>(items: T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('并发数必须是正整数');
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  // Do not leave a phase while other workers are still modifying working copies.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  const failure = settled.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}

export function validateMergeTargets(targets: Array<{ branch: string; path: string }>): void {
  const paths = targets.map(target => {
    const path = existsSync(target.path) ? realpathSync(target.path) : resolve(target.path);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  });
  const contains = (parent: string, child: string) => {
    const remainder = relative(parent, child);
    return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`));
  };
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (contains(paths[i], paths[j]) || contains(paths[j], paths[i])) {
        throw new Error(`目标工作副本路径重复或嵌套: ${targets[i].branch} / ${targets[j].branch}，请调整选择或配置`);
      }
    }
  }
}

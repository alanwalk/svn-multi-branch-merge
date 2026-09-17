/** Hyphen ranges include both endpoints; colon ranges retain SVN's (start, end] semantics. */
export function parseRevisionInput(input: string): string[] {
  const value = input.replace(/\s/g, '');
  if (!value) throw new Error('请输入版本号');
  const revisions = new Set<number>();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:([-:])(\d+))?$/.exec(part);
    if (!match) throw new Error(`无效版本格式: ${part || '空项'}`);
    const start = Number(match[1]);
    const end = Number(match[3] ?? match[1]);
    const first = match[2] === ':' ? start + 1 : start;
    if (![start, end].every(Number.isSafeInteger) || first < 1 || end < first) throw new Error(`无效版本范围: ${part}`);
    if (end - first > 100000) throw new Error('单个区间过大，请使用全合并');
    for (let revision = first; revision <= end; revision++) revisions.add(revision);
  }
  return [...revisions].sort((a, b) => a - b).map(String);
}

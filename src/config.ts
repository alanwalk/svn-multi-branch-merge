import { readFileSync, existsSync } from 'fs';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import type { Config } from './types.js';

export const configPath = () => join(homedir(), '.svnmbm', 'config.jsonc');

export const DEFAULT_CONFIG: Config = {
  branches: {
    trunk: { local_path: './working-copies/trunk', enabled: true },
    release: { local_path: './working-copies/release', enabled: true },
  },
  tree: {
    trunk: ['release'],
  },
};

export function parseConfig(content: string, path = configPath()): Config {
  const text = content.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0];
    const prefix = text.slice(0, error.offset).split('\n');
    throw new Error(`${path}:${prefix.length}:${prefix.at(-1)!.length + 1} 配置语法错误: ${printParseErrorCode(error.error)}`);
  }
  return config as Config;
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`未找到配置文件: ${path}\n请先创建该文件，按以下 JSONC 格式填写 SVN 副本路径和分支关系：\n\n${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n\nlocal_path 可使用绝对路径；相对路径以配置文件所在目录为基准。支持注释和尾随逗号。`);
  }
  const config = parseConfig(readFileSync(path, 'utf-8'), path);
  for (const branch of Object.values(config.branches)) branch.local_path = resolve(dirname(path), branch.local_path);
  return config;
}

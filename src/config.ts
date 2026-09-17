import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import type { Config } from './types.js';

const CONFIG_PATH = './config.jsonc';

export const DEFAULT_CONFIG: Config = {
  branches: {
    trunk: { local_path: './working-copies/trunk', enabled: true },
    release: { local_path: './working-copies/release', enabled: true },
  },
  tree: {
    trunk: ['release'],
  },
};

export function parseConfig(content: string): Config {
  const text = content.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0];
    const prefix = text.slice(0, error.offset).split('\n');
    throw new Error(`${CONFIG_PATH}:${prefix.length}:${prefix.at(-1)!.length + 1} 配置语法错误: ${printParseErrorCode(error.error)}`);
  }
  return config as Config;
}

export function loadConfig(): Config {
  if (existsSync(CONFIG_PATH)) {
    return parseConfig(readFileSync(CONFIG_PATH, 'utf-8'));
  }
  saveConfig(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg: Config): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

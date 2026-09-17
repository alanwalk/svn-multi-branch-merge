export interface BranchConfig {
  local_path: string;
  enabled: boolean;
}

export interface Config {
  branches: Record<string, BranchConfig>;
  tree: Record<string, string[]>;
}

export interface LogEntry {
  rev: string;
  author: string;
  date: string;
  msg: string;
}

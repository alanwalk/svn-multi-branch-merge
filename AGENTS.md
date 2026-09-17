# Repository Guidelines

## Project Structure & Module Organization

This repository provides an interactive Node.js CLI for merging SVN revisions into multiple working copies.

- `src/main.ts`: prompts, revision selection, branch selection, and summary display.
- `src/cli.ts`: positional quick-start arguments and validation; omitted revisions mean full merge.
- `src/branch-select.ts`: direct-child target selection with a source-level select-all control; neither the source nor deeper descendants are targets.
- `src/merger.ts`: conflict resolution, branch results, and confirmation before committing.
- `src/progress.ts`: compact terminal progress with one latest status per branch.
- `src/concurrency.ts`: shared bounded workers and target-path validation for checking, cleanup, and merging.
- `src/workspace.ts`: dirty-workspace checks and ignored-file snapshots.
- `src/merge-ignore.ts`: per-target YAML ignore paths, revert and commit exclusion; preserve overlapping `ignore-on-commit` files.
- `src/svn.ts`: SVN subprocess execution, log parsing, and status checks.
- `src/encoding.ts`: UTF-8/GBK decoding and stream line buffering.
- `src/config.ts`: JSONC configuration loading, saving, and defaults.
- `src/types.ts`: shared configuration and log-entry interfaces.
- `config.jsonc`: branch paths, enabled flags, and branch hierarchy; comments and trailing commas are supported. Commit messages use `Merged revision(s) ... from ...:` followed by full original revision messages separated by `........`.
- `dist/`: generated JavaScript output; `tests/`: regression tests. No dedicated asset directory exists.

## Build, Test, and Development Commands

Run commands from the repository root; configuration resolves relative to the current directory. Install Node.js/npm and make `svn` available on `PATH`.

- `npm ci`: install dependencies from `package-lock.json`.
- `npm start`: launch the TypeScript CLI through `tsx`.
- `npm run dev`: run source directly through `tsx`, without building; equivalent to `npm start`.
- `npm run build`: compile strict TypeScript into `dist/`.
- `npm test`: run regression tests with Node's test runner through `tsx`.
- `npm run run:dist`: launch the compiled CLI.
- `npm start -- --skip-summary-confirm`: skip the post-merge confirmation only when no conflicts occurred.
- `npm run dev -- --concurrency 6`: merge up to six branches concurrently (default six); await all results before summary and commit confirmation.

## Coding Style & Naming Conventions

Use two-space indentation, single-quoted strings, semicolons, and explicit shared types. Follow existing camelCase function/variable names, PascalCase interfaces, and UPPER_SNAKE_CASE constants. Preserve snake_case configuration keys such as `local_path`.

Use ES modules and `.js` extensions in relative TypeScript imports for NodeNext compatibility. Keep prompt orchestration in `main.ts`, tree selection in `branch-select.ts`, and SVN operations in `svn.ts`. No formatter or linter is configured; match surrounding code.

## Testing Guidelines

Name tests `tests/*.test.ts` using `node:test` and `node:assert/strict`. Run `npm test` and `npm run build` for TypeScript changes. No coverage threshold is configured. Exercise integration changes against disposable SVN repositories and working copies, covering revision ordering, Chinese output, missing paths, conflicts, no-change merges, and command failures. Record manual checks in the PR.

## Commit & Pull Request Guidelines

Existing history uses `feat:` and `fix:` prefixes with concise English or Chinese summaries. Keep commits focused. PRs should explain the behavior change, link relevant issues, and report validation; include terminal output for prompt or encoding changes.

## Configuration & SVN Safety

Check all workspaces before updates. At the dirty-workspace prompt, `c` authorizes revert/delete cleanup of selected targets only; preserve `ignore-on-commit`, nested working copies and external link targets. Otherwise require user handling. Exclude fully merged revisions per target from merges and logs. Any incoming touch of `ignore-on-commit` becomes a manual conflict. Commit only explicit planned paths with depth empty. Display all results before confirming commits. Any conflict requires manual confirmation even with `--skip-summary-confirm`. Resolve ordinary conflicts with `theirs-full`; unresolved tree conflicts fall back to `working`. Never commit failed or conflicted branches. Cancellation preserves changes. Tests require `svnadmin` and `svnlook` and use disposable repositories. Keep credentials out of configuration.

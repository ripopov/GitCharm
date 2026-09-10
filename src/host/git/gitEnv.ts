import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';

/**
 * Create a simple-git instance for `baseDir` that runs every command as
 * `git --no-optional-locks …` (git ≥ 2.15; equivalent to GIT_OPTIONAL_LOCKS=0,
 * which git also exports to the child processes it spawns, such as the
 * per-submodule status a `git status` runs in a superproject).
 *
 * Without it, read-only commands such as `git status` take `index.lock` to
 * opportunistically rewrite the index. That lock file is not harmless: VS Code's
 * built-in Git extension watches each repository's git dir and re-runs its own
 * status whenever a file there is created or deleted. It filters `index.lock`
 * only at `.git/` and `.git/worktrees/<name>/`, not inside `modules/` where
 * submodule git dirs live, so on a repository with submodules each GitCharm
 * status sweep made VS Code refresh every submodule, whose state change in turn
 * triggered another GitCharm sweep. VS Code's own git extension sets
 * GIT_OPTIONAL_LOCKS=0 for the same reason.
 *
 * The flag goes through simple-git's `binary` option rather than `env()`: `env()`
 * replaces the inherited environment, and simple-git rejects inherited values such
 * as GIT_EDITOR or PAGER when they are passed explicitly.
 */
const options: Partial<SimpleGitOptions> = { binary: ['git', '--no-optional-locks'] };

export function createGit(baseDir?: string): SimpleGit {
  return baseDir ? simpleGit(baseDir, options) : simpleGit(options);
}

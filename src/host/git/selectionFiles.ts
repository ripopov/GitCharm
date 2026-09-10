/**
 * Changed files of a multi-commit selection in the Git Log.
 *
 * Two strategies, chosen per call:
 *  - the selection is one contiguous first-parent chain → a single
 *    `git diff oldest^..newest` (exact, cheap, what git would show for the range);
 *  - anything else → every selected commit's own changes (vs its first parent) in
 *    one `git show`, folded per path with zipChanges (JetBrains semantics).
 *
 * `run` executes git in the repository and resolves with stdout, so this module
 * stays free of vscode/simple-git and can be tested against a scratch repository.
 */
import {
  EMPTY_TREE,
  parseNameStatusTokens,
  parseNumstatTokens,
  splitShowRecords,
  toSelectionFile,
  zipChanges,
  type FileChange,
  type SelectionFile,
} from './zipChanges';

export type GitRunner = (args: string[]) => Promise<string>;

export interface SelectionFilesResult {
  files: SelectionFile[];
  /** True when the selection was one first-parent chain and a single range diff was used. */
  contiguous: boolean;
}

const SHOW_FORMAT = '--format=%x01%H%x20%P';

/**
 * @param run        executes `git <args>` in the repository
 * @param hashesNewestFirst selected commit hashes in log (newest → oldest) order,
 *                   the order the Git Log table displays them in
 */
export async function getSelectionFiles(run: GitRunner, hashesNewestFirst: readonly string[]): Promise<SelectionFilesResult> {
  const hashes = Array.from(new Set(hashesNewestFirst));
  if (hashes.length === 0) return { files: [], contiguous: true };

  const range = await contiguousRange(run, hashes);
  if (range) return { files: await selectionFilesByRange(run, range.base, range.newest), contiguous: true };
  return { files: await selectionFilesByZip(run, hashes), contiguous: false };
}

/** Files changed between `base` (a tree-ish, possibly EMPTY_TREE) and `newest`, as one diff. */
export async function selectionFilesByRange(run: GitRunner, base: string, newest: string): Promise<SelectionFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    run(['diff', '--name-status', '-M', '-z', base, newest]),
    run(['diff', '--numstat', '-M', '-z', base, newest]),
  ]);
  const stats = parseNumstatTokens(numstat.split('\0'));
  return parseNameStatusTokens(nameStatus.split('\0'), base, newest, stats).map(toSelectionFile);
}

/**
 * Each commit's own changes (merges vs their first parent), concatenated oldest →
 * newest and folded per path. `hashes` are newest first.
 */
export async function selectionFilesByZip(run: GitRunner, hashes: readonly string[]): Promise<SelectionFile[]> {
  if (hashes.length === 0) return [];
  const [nameStatus, numstat] = await Promise.all([
    run(['show', '--name-status', '-M', '-z', SHOW_FORMAT, '--first-parent', '-m', ...hashes]),
    run(['show', '--numstat', '-M', '-z', SHOW_FORMAT, '--first-parent', '-m', ...hashes]),
  ]);
  const statsByHash = new Map(splitShowRecords(numstat).map(r => [r.hash, parseNumstatTokens(r.tokens)]));
  const changesByHash = new Map<string, FileChange[]>();
  for (const record of splitShowRecords(nameStatus)) {
    const beforeRef = record.parents[0] ?? EMPTY_TREE;
    changesByHash.set(record.hash, parseNameStatusTokens(record.tokens, beforeRef, record.hash, statsByHash.get(record.hash)));
  }
  const oldestFirst: FileChange[] = [];
  for (let i = hashes.length - 1; i >= 0; i--) {
    oldestFirst.push(...(changesByHash.get(hashes[i]) ?? []));
  }
  return zipChanges(oldestFirst).map(toSelectionFile);
}

/**
 * If `hashes` (newest first) are exactly the first-parent chain ending at
 * `hashes[0]`, return the range to diff: `base` is the oldest commit's first
 * parent, or the empty tree when the oldest commit is a root.
 */
async function contiguousRange(run: GitRunner, hashes: string[]): Promise<{ base: string; newest: string } | null> {
  const newest = hashes[0];
  const raw = await run(['rev-list', '--first-parent', `--max-count=${hashes.length + 1}`, newest]);
  const chain = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (chain.length < hashes.length) return null;
  const selected = new Set(hashes);
  for (let i = 0; i < hashes.length; i++) {
    if (!selected.has(chain[i])) return null;
  }
  return { base: chain[hashes.length] ?? EMPTY_TREE, newest };
}

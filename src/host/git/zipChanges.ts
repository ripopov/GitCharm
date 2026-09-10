/**
 * Folding of per-commit change lists into one combined change list, used when
 * several commits are selected in the Git Log.
 *
 * Semantics follow JetBrains' VcsLogUtil.collectChanges →
 * CommittedChangesTreeBrowser.zipChanges (reimplemented, not copied): changes are
 * visited oldest → newest and folded per path, keeping the before-revision of the
 * earliest change and the after-revision of the latest one.
 *
 * Everything here is pure (no git, no vscode) so it can be unit tested.
 */

/** SHA of git's empty tree — the "before" side of an added file / "after" side of a deleted one. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A file at a specific revision. `ref` is a commit hash (or EMPTY_TREE). */
export interface FileRevision {
  ref: string;
  path: string;
}

/** One change of one file: `before === null` ⇒ added, `after === null` ⇒ deleted. */
export interface FileChange {
  before: FileRevision | null;
  after: FileRevision | null;
  added?: number;
  removed?: number;
}

/** What the Git Log webview renders for a file of a multi-commit selection. */
export interface SelectionFile {
  path: string;
  status: string;
  added?: number;
  removed?: number;
  oldPath?: string;
  /** Revision holding the "before" content of `oldPath ?? path` (EMPTY_TREE when added). */
  beforeRef: string;
  /** Revision holding the "after" content of `path` (EMPTY_TREE when deleted). */
  afterRef: string;
}

function keyOf(rev: FileRevision): string {
  return rev.path;
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/**
 * Fold `changes` (ordered oldest → newest) per path.
 *
 * - modified + modified → modified (before from the first, after from the last)
 * - added + modified → added; added + deleted → dropped
 * - modified + deleted → deleted; deleted + added → modified
 * - rename A→B then B→C → rename A→C; a later change to B follows the rename
 *
 * Paths that never interact keep their relative order; a folded entry moves to
 * the position of its latest change.
 */
export function zipChanges(changes: readonly FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const take = (path: string): FileChange | undefined => {
    const prev = byPath.get(path);
    if (prev) byPath.delete(path);
    return prev;
  };

  for (const change of changes) {
    const { before, after } = change;
    if (before && after) {
      // Modified or renamed: continue whatever history the old path already had.
      const prev = take(keyOf(before));
      byPath.set(keyOf(after), prev
        ? { before: prev.before, after, added: sum(prev.added, change.added), removed: sum(prev.removed, change.removed) }
        : change);
    } else if (after) {
      // Added: re-adding a file that was deleted earlier in the selection is a modification.
      const prev = take(keyOf(after));
      byPath.set(keyOf(after), prev?.before
        ? { before: prev.before, after, added: sum(prev.added, change.added), removed: sum(prev.removed, change.removed) }
        : change);
    } else if (before) {
      // Deleted: a file that was added earlier in the selection never existed outside it.
      const prev = take(keyOf(before));
      if (!prev) byPath.set(keyOf(before), change);
      else if (prev.before) byPath.set(keyOf(before), { before: prev.before, after: null, added: sum(prev.added, change.added), removed: sum(prev.removed, change.removed) });
    }
  }
  return Array.from(byPath.values());
}

/** Convert a (possibly folded) change into the row shape the webview shows. */
export function toSelectionFile(change: FileChange): SelectionFile {
  const { before, after } = change;
  const stats = { added: change.added, removed: change.removed };
  if (before && after) {
    const renamed = before.path !== after.path;
    return { path: after.path, status: renamed ? 'R' : 'M', ...(renamed ? { oldPath: before.path } : {}), ...stats, beforeRef: before.ref, afterRef: after.ref };
  }
  if (after) return { path: after.path, status: 'A', ...stats, beforeRef: EMPTY_TREE, afterRef: after.ref };
  if (before) return { path: before.path, status: 'D', ...stats, beforeRef: before.ref, afterRef: EMPTY_TREE };
  throw new Error('FileChange must have a before or an after revision');
}

/** Line counts keyed by (new) path, as parsed from `--numstat`. */
export type NumstatMap = Map<string, { added: number; removed: number }>;

/**
 * Parse the NUL-separated tokens of `git diff|show --name-status -z` output
 * (already split on "\0"), producing changes between `beforeRef` and `afterRef`.
 * Tokens are trimmed, so the leading newline git prints after a commit header is harmless.
 */
export function parseNameStatusTokens(tokens: readonly string[], beforeRef: string, afterRef: string, stats?: NumstatMap): FileChange[] {
  const changes: FileChange[] = [];
  let i = 0;
  const next = (): string | undefined => tokens[i++];
  while (i < tokens.length) {
    const status = next()?.trim();
    if (!status) continue;
    const code = status[0];
    if (code === 'R' || code === 'C') {
      const oldPath = next();
      const newPath = next();
      if (oldPath === undefined || newPath === undefined) break;
      const s = stats?.get(newPath);
      // A copy leaves the source untouched, so it is an addition of the new path.
      changes.push({
        before: code === 'R' ? { ref: beforeRef, path: oldPath } : null,
        after: { ref: afterRef, path: newPath },
        ...(s ?? {}),
      });
      continue;
    }
    const filePath = next();
    if (filePath === undefined) break;
    const s = stats?.get(filePath);
    if (code === 'A') changes.push({ before: null, after: { ref: afterRef, path: filePath }, ...(s ?? {}) });
    else if (code === 'D') changes.push({ before: { ref: beforeRef, path: filePath }, after: null, ...(s ?? {}) });
    else changes.push({ before: { ref: beforeRef, path: filePath }, after: { ref: afterRef, path: filePath }, ...(s ?? {}) });
  }
  return changes;
}

/**
 * Parse the NUL-separated tokens of `git diff|show --numstat -z` output.
 * Regular entries are one token "added\tremoved\tpath"; renames are
 * "added\tremoved\t" followed by two path tokens. Binary files report "-".
 */
export function parseNumstatTokens(tokens: readonly string[]): NumstatMap {
  const stats: NumstatMap = new Map();
  let i = 0;
  while (i < tokens.length) {
    // Only strip newlines: a rename entry ends in a tab that must survive.
    const entry = tokens[i++]?.replace(/^\n+|\n+$/g, '');
    if (!entry) continue;
    const parts = entry.split('\t');
    if (parts.length < 3) continue;
    let filePath = parts.slice(2).join('\t');
    if (filePath === '') {
      // rename/copy: the two paths follow as separate tokens
      i++; // old path
      filePath = tokens[i++] ?? '';
    }
    const added = parseInt(parts[0], 10);
    const removed = parseInt(parts[1], 10);
    if (!isNaN(added) && !isNaN(removed)) stats.set(filePath, { added, removed });
  }
  return stats;
}

/** One commit's block of `git show --format=%x01%H %P -z` output. */
export interface ShowRecord {
  hash: string;
  parents: string[];
  /** Diff tokens (already split on "\0"). */
  tokens: string[];
}

/**
 * Split the output of `git show -z --format=%x01%H %P …` into per-commit records.
 * Each record starts with "\x01<hash> <parents…>" followed by a NUL and the diff tokens.
 */
export function splitShowRecords(raw: string): ShowRecord[] {
  const records: ShowRecord[] = [];
  for (const block of raw.split('\x01')) {
    if (!block) continue;
    const tokens = block.split('\0');
    const header = (tokens.shift() ?? '').trim().split(/\s+/).filter(Boolean);
    const hash = header[0];
    if (!hash) continue;
    records.push({ hash, parents: header.slice(1), tokens });
  }
  return records;
}

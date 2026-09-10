/**
 * Pure bookkeeping for status refreshes, kept free of `vscode` so it can be unit-tested.
 *
 * A refresh is requested for a subset of repositories (the one whose state VS Code
 * reported, the one a saved file belongs to) or for all of them. Requests that arrive
 * while a sweep is running or debouncing are merged into one pending scope instead of
 * each starting its own sweep: with dozens of nested submodules, overlapping sweeps
 * spawned hundreds of git processes per second and starved the log itself.
 */
export class RefreshScope {
  private all = false;
  private ids = new Set<string>();
  private pending = false;

  /** Ask for a refresh of `repoIds`, or of every repository when omitted. */
  request(repoIds?: readonly string[]): void {
    this.pending = true;
    if (!repoIds) { this.all = true; this.ids.clear(); return; }
    if (this.all) return;
    for (const id of repoIds) this.ids.add(id);
  }

  isPending(): boolean {
    return this.pending;
  }

  /** Hand out and reset the pending scope; `null` when nothing was requested. */
  take(): { all: boolean; ids: string[] } | null {
    if (!this.pending) return null;
    const scope = { all: this.all, ids: Array.from(this.ids) };
    this.all = false;
    this.ids.clear();
    this.pending = false;
    return scope;
  }
}

/**
 * Assemble a full status list in repository order from freshly queried entries,
 * falling back to the last known entry for repositories outside the queried scope.
 * Repositories with neither are left out.
 */
export function mergeRepoStatuses<T extends { repoId: string }>(
  order: readonly string[],
  fresh: ReadonlyMap<string, T>,
  cached: ReadonlyMap<string, T>,
): T[] {
  const out: T[] = [];
  for (const id of order) {
    const status = fresh.get(id) ?? cached.get(id);
    if (status) out.push(status);
  }
  return out;
}

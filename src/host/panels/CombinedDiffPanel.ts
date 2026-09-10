import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { showGitError } from '../utils/gitErrorUtils';
import { logWarn } from '../utils/Logger';
import { EMPTY_TREE } from '../git/zipChanges';

function gitUri(rootPath: string, ref: string, filePath: string): vscode.Uri {
  const fileUri = vscode.Uri.file(path.join(rootPath, filePath));
  return vscode.Uri.from({ scheme: 'git', path: fileUri.path, query: JSON.stringify({ path: fileUri.fsPath, ref }) });
}

/**
 * Open the diff of one row of a multi-commit selection: `oldPath ?? filePath` at
 * `beforeRef` against `filePath` at `afterRef` (see SelectionFile). For a
 * contiguous selection both refs are the range endpoints; for a folded selection
 * they are the earliest change's parent and the latest change's commit.
 */
export async function openRangeFileDiff(
  manager: WorkspaceGitManager,
  repoId: string,
  beforeRef: string,
  afterRef: string,
  filePath: string,
  status?: string,
  oldPath?: string,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    vscode.window.showErrorMessage('Repository not found.');
    return;
  }

  try {
    const originalPath = oldPath ?? filePath;
    const original = gitUri(repo.rootPath, status === 'A' ? EMPTY_TREE : beforeRef, originalPath);
    const modified = gitUri(repo.rootPath, status === 'D' ? EMPTY_TREE : afterRef, filePath);
    const label = (ref: string) => ref === EMPTY_TREE ? '∅' : ref.slice(0, 7);
    const title = `${path.basename(filePath)} (${label(beforeRef)}…${label(afterRef)})`;
    await vscode.commands.executeCommand('vscode.diff', original, modified, title);
  } catch (e: unknown) {
    showGitError('rangeDiff', e);
  }
}

export async function openCombinedDiffPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  repoId: string,
  hashes: string[],
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    logWarn('combinedDiff', 'Repository not found.');
    vscode.window.showErrorMessage('Repository not found.');
    return;
  }
  if (hashes.length < 2) {
    logWarn('combinedDiff', 'Select at least 2 commits to view combined diff.');
    vscode.window.showErrorMessage('Select at least 2 commits to view combined diff.');
    return;
  }

  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let commitMetas: Array<{ hash: string; shortHash: string; message: string; authorName: string; authorDate: string }> = [];
  let orderedHashes: string[] = [];

  try {
    [files, commitMetas] = await Promise.all([
      repo.getCombinedFiles(hashes),
      Promise.all(hashes.map(h =>
        repo.getCommitMeta(h).then(m => m
          ? { hash: m.hash, shortHash: m.shortHash, message: m.message, authorName: m.authorName, authorDate: m.authorDate }
          : { hash: h, shortHash: h.slice(0, 7), message: '', authorName: '', authorDate: '' }
        )
      )),
    ]);
    orderedHashes = await repo.getCombinedFilesOrder(hashes);
    commitMetas.sort((a, b) => orderedHashes.indexOf(a.hash) - orderedHashes.indexOf(b.hash));
  } catch (e: unknown) {
    showGitError('combinedDiff', e);
    return;
  }

  if (files.length === 0) {
    logWarn('combinedDiff', `No files found for the selected commits (hashes: ${hashes.map(h => h.slice(0, 7)).join(', ')}).`);
    vscode.window.showWarningMessage(`No files found for the selected commits (hashes: ${hashes.map(h => h.slice(0, 7)).join(', ')}). The commits may not be in the same repository branch.`);
    return;
  }

  const oldest = commitMetas[0];
  const newest = commitMetas[commitMetas.length - 1];
  const rootPath = repo.rootPath;

  const resources = files
    .filter(f => f.status !== 'U')
    .map(f => {
      const label = vscode.Uri.file(path.join(rootPath, f.path));
      const original = gitUri(rootPath, f.status === 'A' ? EMPTY_TREE : `${oldest.hash}~1`, f.path);
      const modified = gitUri(rootPath, f.status === 'D' ? EMPTY_TREE : newest.hash, f.path);
      return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
    });

  const title = `${oldest.shortHash}…${newest.shortHash} (${hashes.length} commits)`;
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}


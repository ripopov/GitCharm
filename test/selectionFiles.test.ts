/**
 * Integration test: builds a scratch repository with the git CLI in the OS temp
 * directory and checks getSelectionFiles against it.
 *
 * History (main is the first-parent line, newest at the top):
 *
 *   c7  modify b2
 *   c6  re-add a
 *   c5  delete a
 *   c4  merge feat (--no-ff)        feat: f1 add f, f2 modify f
 *   c3  rename b → b2
 *   c2  modify a
 *   c1  add a, b                     (root)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getSelectionFiles, selectionFilesByZip, type GitRunner } from '../src/host/git/selectionFiles';
import { EMPTY_TREE, type SelectionFile } from '../src/host/git/zipChanges';

const execFileAsync = promisify(execFile);

let dir: string;
let run: GitRunner;
const c: Record<string, string> = {};

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: dir,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: dir },
  });
  return stdout;
}

async function commit(name: string, message: string): Promise<void> {
  await git('add', '-A');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', message);
  c[name] = (await git('rev-parse', 'HEAD')).trim();
}

function write(rel: string, content: string) {
  fs.writeFileSync(path.join(dir, rel), content);
}

const shape = (files: SelectionFile[]) => files.map(f => [f.status, f.path, f.oldPath].filter(x => x !== undefined));
const byPath = (files: SelectionFile[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-selection-'));
  run = args => git(...args);
  await git('init', '-q', '-b', 'main');
  write('a', 'a1\n'); write('b', 'b1\n');
  await commit('c1', 'c1 add a, b');
  write('a', 'a2\n');
  await commit('c2', 'c2 modify a');
  await git('mv', 'b', 'b2');
  await commit('c3', 'c3 rename b -> b2');
  await git('checkout', '-q', '-b', 'feat', c.c2);
  write('f', 'f1\n');
  await commit('f1', 'f1 add f');
  write('f', 'f1\nf2\n');
  await commit('f2', 'f2 modify f');
  await git('checkout', '-q', 'main');
  await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'c4 merge feat', 'feat');
  c.c4 = (await git('rev-parse', 'HEAD')).trim();
  fs.unlinkSync(path.join(dir, 'a'));
  await commit('c5', 'c5 delete a');
  write('a', 'a3\n');
  await commit('c6', 'c6 re-add a');
  write('b2', 'b1\nb2\n');
  await commit('c7', 'c7 modify b2');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('getSelectionFiles', () => {
  it('uses one range diff for a contiguous first-parent selection', async () => {
    const result = await getSelectionFiles(run, [c.c7, c.c6, c.c5]);
    assert.equal(result.contiguous, true);
    // a was deleted and re-added with new content: net effect is a modification
    assert.deepEqual(shape(byPath(result.files)), [['M', 'a'], ['M', 'b2']]);
    for (const f of result.files) {
      assert.equal(f.beforeRef, c.c4);
      assert.equal(f.afterRef, c.c7);
    }
    const b2 = result.files.find(f => f.path === 'b2')!;
    assert.deepEqual([b2.added, b2.removed], [1, 0]);
  });

  it('accepts a selection in any order as long as the newest commit is first', async () => {
    const result = await getSelectionFiles(run, [c.c7, c.c5, c.c6]);
    assert.equal(result.contiguous, true);
    assert.deepEqual(shape(byPath(result.files)), [['M', 'a'], ['M', 'b2']]);
  });

  it('folds each commit\'s own changes for a non-contiguous pair', async () => {
    const result = await getSelectionFiles(run, [c.c7, c.c2]);
    assert.equal(result.contiguous, false);
    // oldest first: c2 (a) then c7 (b2); each row diffs against its own commit
    assert.deepEqual(result.files, [
      { path: 'a', status: 'M', added: 1, removed: 1, beforeRef: c.c1, afterRef: c.c2 },
      { path: 'b2', status: 'M', added: 1, removed: 0, beforeRef: c.c6, afterRef: c.c7 },
    ]);
  });

  it('folds modify + delete into a deletion with the earliest before-revision', async () => {
    const result = await getSelectionFiles(run, [c.c5, c.c2]);
    assert.equal(result.contiguous, false);
    assert.deepEqual(result.files, [
      { path: 'a', status: 'D', added: 1, removed: 2, beforeRef: c.c1, afterRef: EMPTY_TREE },
    ]);
  });

  it('drops a file that is added and deleted inside a non-contiguous selection', async () => {
    const result = await getSelectionFiles(run, [c.c5, c.c1]);
    assert.equal(result.contiguous, false);
    assert.deepEqual(result.files, [
      { path: 'b', status: 'A', added: 1, removed: 0, beforeRef: EMPTY_TREE, afterRef: c.c1 },
    ]);
  });

  it('treats a merge commit as its diff against the first parent (contiguous)', async () => {
    const result = await getSelectionFiles(run, [c.c5, c.c4, c.c3]);
    assert.equal(result.contiguous, true);
    assert.deepEqual(shape(byPath(result.files)), [['D', 'a'], ['R', 'b2', 'b'], ['A', 'f']]);
  });

  it('spanning a merge with its side-branch commits falls back to zip and does not double count', async () => {
    const result = await getSelectionFiles(run, [c.c4, c.f2, c.f1]);
    assert.equal(result.contiguous, false);
    // f1 adds f, f2 modifies f, c4 (vs c3) adds f again → a single addition carrying the last one's stats
    assert.deepEqual(result.files, [
      { path: 'f', status: 'A', added: 2, removed: 0, beforeRef: EMPTY_TREE, afterRef: c.c4 },
    ]);
  });

  it('handles the root commit in a contiguous selection', async () => {
    const result = await getSelectionFiles(run, [c.c2, c.c1]);
    assert.equal(result.contiguous, true);
    assert.deepEqual(result.files, [
      { path: 'a', status: 'A', added: 1, removed: 0, beforeRef: EMPTY_TREE, afterRef: c.c2 },
      { path: 'b', status: 'A', added: 1, removed: 0, beforeRef: EMPTY_TREE, afterRef: c.c2 },
    ]);
  });

  it('handles the root commit in a zipped selection', async () => {
    const result = await getSelectionFiles(run, [c.c3, c.c1]);
    assert.equal(result.contiguous, false);
    // b added in c1, renamed to b2 in c3 → an addition of b2
    assert.deepEqual(shape(byPath(result.files)), [['A', 'a'], ['A', 'b2']]);
    const b2 = result.files.find(f => f.path === 'b2')!;
    assert.equal(b2.beforeRef, EMPTY_TREE);
    assert.equal(b2.afterRef, c.c3);
  });

  it('produces the same result through simple-git raw, the runner GitService uses', async () => {
    const { default: simpleGit } = await import('simple-git');
    const sg = simpleGit(dir);
    const viaSimpleGit: GitRunner = args => sg.raw(args);
    for (const hashes of [[c.c7, c.c6, c.c5], [c.c7, c.c2], [c.c4, c.f2, c.f1], [c.c3, c.c1]]) {
      assert.deepEqual(await getSelectionFiles(viaSimpleGit, hashes), await getSelectionFiles(run, hashes), hashes.join(','));
    }
  });

  it('returns nothing for an empty selection', async () => {
    assert.deepEqual(await getSelectionFiles(run, []), { files: [], contiguous: true });
  });

  it('range and zip strategies agree on linear selections', async () => {
    const linear: string[][] = [
      [c.c7, c.c6, c.c5],
      [c.c3, c.c2, c.c1],
      [c.c2, c.c1],
      [c.c6, c.c5],
      [c.c7, c.c6, c.c5, c.c4, c.c3, c.c2, c.c1],
    ];
    for (const hashes of linear) {
      const range = await getSelectionFiles(run, hashes);
      assert.equal(range.contiguous, true, hashes.join(','));
      const zip = await selectionFilesByZip(run, hashes);
      assert.deepEqual(shape(byPath(zip)), shape(byPath(range.files)), hashes.join(','));
    }
  });
});

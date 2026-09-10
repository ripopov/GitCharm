// createGit() must run git with --no-optional-locks so read-only commands never
// touch index.lock (see gitEnv.ts for why that matters next to VS Code's git
// extension). Observable effect: `git status` on a stale index — a tracked file
// whose mtime changed but whose content did not — normally rewrites the index
// with fresh stat data; without optional locks it leaves the index untouched.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { createGit } from '../src/host/git/gitEnv';

const run = promisify(execFile);

describe('createGit', () => {
  let dir: string;
  let indexPath: string;
  let staleness = 0;

  const git = (...args: string[]) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });
  const indexMtime = () => fs.statSync(indexPath).mtimeMs;
  /** Bump the tracked file's mtime past the stat data recorded in the index. */
  const makeIndexStale = () => {
    staleness += 10;
    const t = new Date(Date.now() + staleness * 1000);
    fs.utimesSync(path.join(dir, 'a.txt'), t, t);
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcharm-gitenv-'));
    indexPath = path.join(dir, '.git', 'index');
    await git('init', '-q', '.');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    await git('add', 'a.txt');
    await git('commit', '-q', '-m', 'a');
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('plain simple-git status rewrites a stale index (premise of the next test)', async () => {
    makeIndexStale();
    const before = indexMtime();
    await simpleGit(dir).status();
    assert.notEqual(indexMtime(), before);
  });

  it('createGit status leaves a stale index untouched', async () => {
    makeIndexStale();
    const before = indexMtime();
    const status = await createGit(dir).status();
    assert.equal(status.files.length, 0, 'content unchanged, so the tree must still be clean');
    assert.equal(indexMtime(), before);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_TREE,
  parseNameStatusTokens,
  parseNumstatTokens,
  splitShowRecords,
  toSelectionFile,
  zipChanges,
  type FileChange,
} from '../src/host/git/zipChanges';

const rev = (ref: string, path: string) => ({ ref, path });
const M = (path: string, from: string, to: string, added?: number, removed?: number): FileChange =>
  ({ before: rev(from, path), after: rev(to, path), added, removed });
const A = (path: string, to: string, added?: number): FileChange => ({ before: null, after: rev(to, path), added, removed: added === undefined ? undefined : 0 });
const D = (path: string, from: string): FileChange => ({ before: rev(from, path), after: null });
const R = (from: string, to: string, fromRef: string, toRef: string): FileChange => ({ before: rev(fromRef, from), after: rev(toRef, to) });

const rows = (changes: FileChange[]) => zipChanges(changes).map(toSelectionFile);

describe('zipChanges', () => {
  it('M + M → M with the earliest before and the latest after', () => {
    const [f, ...rest] = rows([M('a', 'p1', 'c1', 1, 1), M('a', 'c1', 'c2', 2, 0)]);
    assert.equal(rest.length, 0);
    assert.deepEqual(f, { path: 'a', status: 'M', added: 3, removed: 1, beforeRef: 'p1', afterRef: 'c2' });
  });

  it('A + M → A', () => {
    const [f] = rows([A('a', 'c1'), M('a', 'c1', 'c2')]);
    assert.equal(f.status, 'A');
    assert.equal(f.beforeRef, EMPTY_TREE);
    assert.equal(f.afterRef, 'c2');
  });

  it('M + D → D', () => {
    const [f] = rows([M('a', 'p1', 'c1'), D('a', 'c1')]);
    assert.deepEqual(f, { path: 'a', status: 'D', added: undefined, removed: undefined, beforeRef: 'p1', afterRef: EMPTY_TREE });
  });

  it('A + D is dropped', () => {
    assert.deepEqual(rows([A('a', 'c1'), D('a', 'c1')]), []);
  });

  it('D + A → M', () => {
    const [f] = rows([D('a', 'p1'), A('a', 'c2')]);
    assert.equal(f.status, 'M');
    assert.equal(f.beforeRef, 'p1');
    assert.equal(f.afterRef, 'c2');
  });

  it('rename chain A→B→C collapses to A→C', () => {
    const [f, ...rest] = rows([R('a', 'b', 'p1', 'c1'), R('b', 'c', 'c1', 'c2')]);
    assert.equal(rest.length, 0);
    assert.deepEqual(f, { path: 'c', status: 'R', oldPath: 'a', added: undefined, removed: undefined, beforeRef: 'p1', afterRef: 'c2' });
  });

  it('rename + modify keeps the rename and the latest content', () => {
    const [f] = rows([R('a', 'b', 'p1', 'c1'), M('b', 'c1', 'c2', 5, 2)]);
    assert.equal(f.status, 'R');
    assert.equal(f.oldPath, 'a');
    assert.equal(f.path, 'b');
    assert.equal(f.afterRef, 'c2');
    assert.equal(f.added, 5);
  });

  it('a file added at the old path after a rename is independent of the rename', () => {
    const result = rows([R('a', 'b', 'p1', 'c1'), A('a', 'c2')]);
    assert.deepEqual(result.map(f => [f.path, f.status]), [['b', 'R'], ['a', 'A']]);
  });

  it('unrelated paths keep their order', () => {
    const result = rows([M('x', 'p1', 'c1'), A('y', 'c1'), D('z', 'c1'), M('w', 'c1', 'c2')]);
    assert.deepEqual(result.map(f => f.path), ['x', 'y', 'z', 'w']);
  });

  it('a folded path moves to the position of its latest change', () => {
    const result = rows([M('a', 'p1', 'c1'), M('b', 'p1', 'c1'), M('a', 'c1', 'c2')]);
    assert.deepEqual(result.map(f => f.path), ['b', 'a']);
  });
});

describe('name-status / numstat -z parsing', () => {
  const nameStatus = 'M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0added.ts\0D\0gone.ts\0';
  const numstat = '3\t1\tsrc/a.ts\0' + '0\t0\t\0old.ts\0new.ts\0' + '10\t0\tadded.ts\0' + '0\t4\tgone.ts\0' + '-\t-\tbin.png\0';

  it('parses statuses, renames and stats', () => {
    const stats = parseNumstatTokens(numstat.split('\0'));
    assert.deepEqual(stats.get('new.ts'), { added: 0, removed: 0 });
    assert.equal(stats.has('bin.png'), false);
    const files = parseNameStatusTokens(nameStatus.split('\0'), 'base', 'tip', stats).map(toSelectionFile);
    assert.deepEqual(files, [
      { path: 'src/a.ts', status: 'M', added: 3, removed: 1, beforeRef: 'base', afterRef: 'tip' },
      { path: 'new.ts', status: 'R', oldPath: 'old.ts', added: 0, removed: 0, beforeRef: 'base', afterRef: 'tip' },
      { path: 'added.ts', status: 'A', added: 10, removed: 0, beforeRef: EMPTY_TREE, afterRef: 'tip' },
      { path: 'gone.ts', status: 'D', added: 0, removed: 4, beforeRef: 'base', afterRef: EMPTY_TREE },
    ]);
  });

  it('splits git show records on the \\x01 header marker', () => {
    const raw = '\x01aaa bbb\0\nM\0a\0' + '\x01bbb \0\nA\0a\0';
    const records = splitShowRecords(raw);
    assert.deepEqual(records.map(r => [r.hash, r.parents]), [['aaa', ['bbb']], ['bbb', []]]);
    assert.deepEqual(parseNameStatusTokens(records[1].tokens, EMPTY_TREE, 'bbb').map(toSelectionFile), [
      { path: 'a', status: 'A', added: undefined, removed: undefined, beforeRef: EMPTY_TREE, afterRef: 'bbb' },
    ]);
  });
});

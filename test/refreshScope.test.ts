import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RefreshScope, mergeRepoStatuses } from '../src/host/git/refreshScope';

describe('RefreshScope', () => {
  it('starts with nothing pending', () => {
    const scope = new RefreshScope();
    assert.equal(scope.isPending(), false);
    assert.equal(scope.take(), null);
  });

  it('merges repo-scoped requests into one scope and resets on take', () => {
    const scope = new RefreshScope();
    scope.request(['a']);
    scope.request(['b', 'a']);
    assert.equal(scope.isPending(), true);
    assert.deepEqual(scope.take(), { all: false, ids: ['a', 'b'] });
    assert.equal(scope.isPending(), false);
    assert.equal(scope.take(), null);
  });

  it('widens to all repos when any request is unscoped, in either order', () => {
    const first = new RefreshScope();
    first.request(['a']);
    first.request();
    assert.deepEqual(first.take(), { all: true, ids: [] });

    const second = new RefreshScope();
    second.request();
    second.request(['a']);
    assert.deepEqual(second.take(), { all: true, ids: [] });
  });

  it('accepts new requests after a take', () => {
    const scope = new RefreshScope();
    scope.request();
    scope.take();
    scope.request(['c']);
    assert.deepEqual(scope.take(), { all: false, ids: ['c'] });
  });
});

describe('mergeRepoStatuses', () => {
  const s = (repoId: string, tag: string) => ({ repoId, tag });

  it('prefers fresh entries, falls back to cached ones, keeps repo order', () => {
    const fresh = new Map([['b', s('b', 'fresh')]]);
    const cached = new Map([['a', s('a', 'old')], ['b', s('b', 'old')], ['c', s('c', 'old')]]);
    assert.deepEqual(mergeRepoStatuses(['a', 'b', 'c'], fresh, cached), [
      s('a', 'old'), s('b', 'fresh'), s('c', 'old'),
    ]);
  });

  it('omits repos that have neither a fresh nor a cached entry', () => {
    const fresh = new Map([['a', s('a', 'fresh')]]);
    assert.deepEqual(mergeRepoStatuses(['x', 'a'], fresh, new Map()), [s('a', 'fresh')]);
  });
});

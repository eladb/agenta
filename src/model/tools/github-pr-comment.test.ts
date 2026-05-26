import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internal, githubPrComment } from './github-pr-comment';

const CTX = { threadKey: 'unit-test' };

describe('github_pr_comment', () => {
  describe('describe()', () => {
    test('handles null/empty args', () => {
      expect(() => githubPrComment.describe?.(null)).not.toThrow();
      expect(githubPrComment.describe?.(null)).toBe('comment on ?#?');
      expect(githubPrComment.describe?.({})).toBe('comment on ?#?');
    });

    test('shows repo + pull_number when provided', () => {
      expect(
        githubPrComment.describe?.({ repo: 'eladb/x', pull_number: 7 }),
      ).toBe('comment on eladb/x#7');
    });

    test('shows edit when comment_id present', () => {
      expect(
        githubPrComment.describe?.({ repo: 'a/b', pull_number: 3, comment_id: 999 }),
      ).toBe('edit comment on a/b#3');
    });

    test('stays single-line', () => {
      const out = githubPrComment.describe?.({ repo: 'a/b', pull_number: 1 }) ?? '';
      expect(out.includes('\n')).toBe(false);
    });
  });

  describe('parseArgs', () => {
    const ok = { repo: 'owner/name', pull_number: 5, body: 'Hello' };

    test('accepts valid args without comment_id', () => {
      const r = _internal.parseArgs(ok);
      expect(r.repo).toBe('owner/name');
      expect(r.pull_number).toBe(5);
      expect(r.body).toBe('Hello');
      expect(r.comment_id).toBeUndefined();
    });

    test('accepts comment_id when provided', () => {
      const r = _internal.parseArgs({ ...ok, comment_id: 123 });
      expect(r.comment_id).toBe(123);
    });

    test('ignores invalid comment_id', () => {
      expect(_internal.parseArgs({ ...ok, comment_id: 'abc' }).comment_id).toBeUndefined();
      expect(_internal.parseArgs({ ...ok, comment_id: 0 }).comment_id).toBeUndefined();
      expect(_internal.parseArgs({ ...ok, comment_id: -1 }).comment_id).toBeUndefined();
    });

    test('rejects malformed repo', () => {
      expect(() => _internal.parseArgs({ ...ok, repo: 'nope' })).toThrow(/repo.*owner\/name/);
    });

    test('rejects missing/invalid pull_number', () => {
      expect(() => _internal.parseArgs({ ...ok, pull_number: 0 })).toThrow(/pull_number/);
      expect(() => _internal.parseArgs({ ...ok, pull_number: 'x' })).toThrow(/pull_number/);
    });

    test('rejects missing/empty body', () => {
      expect(() => _internal.parseArgs({ repo: 'a/b', pull_number: 1, body: '' })).toThrow(/body/);
      expect(() => _internal.parseArgs({ repo: 'a/b', pull_number: 1 })).toThrow(/body/);
    });
  });

  describe('GITHUB_TOKEN guard', () => {
    const PREV = process.env.GITHUB_TOKEN;
    beforeEach(() => {
      delete process.env.GITHUB_TOKEN;
    });
    afterEach(() => {
      if (PREV === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = PREV;
    });

    test('throws clearly when GITHUB_TOKEN is unset', async () => {
      await expect(
        githubPrComment.invoke({ repo: 'a/b', pull_number: 1, body: 'hi' }, CTX),
      ).rejects.toThrow(/GITHUB_TOKEN.*not set/);
    });
  });
});

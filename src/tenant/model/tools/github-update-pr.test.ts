import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internal, githubUpdatePr } from './github-update-pr';

const CTX = { threadKey: 'unit-test' };

describe('github_update_pr', () => {
  describe('describe()', () => {
    test('handles null/empty args', () => {
      expect(() => githubUpdatePr.describe?.(null)).not.toThrow();
      expect(githubUpdatePr.describe?.(null)).toBe('update PR ?#?');
      expect(githubUpdatePr.describe?.({})).toBe('update PR ?#?');
    });

    test('shows repo + pull_number when provided', () => {
      expect(githubUpdatePr.describe?.({ repo: 'eladb/x', pull_number: 42 })).toBe(
        'update PR eladb/x#42',
      );
    });

    test('stays single-line', () => {
      const out = githubUpdatePr.describe?.({ repo: 'a/b', pull_number: 1 }) ?? '';
      expect(out.includes('\n')).toBe(false);
    });
  });

  describe('parseArgs', () => {
    const ok = { repo: 'owner/name', pull_number: 5, title: 'New title' };

    test('accepts title only', () => {
      const r = _internal.parseArgs(ok);
      expect(r.title).toBe('New title');
      expect(r.body).toBeUndefined();
    });

    test('accepts body only', () => {
      const r = _internal.parseArgs({ repo: 'a/b', pull_number: 1, body: 'text' });
      expect(r.body).toBe('text');
      expect(r.title).toBeUndefined();
    });

    test('rejects malformed repo', () => {
      expect(() => _internal.parseArgs({ ...ok, repo: 'nope' })).toThrow(/repo.*owner\/name/);
    });

    test('rejects missing/invalid pull_number', () => {
      expect(() => _internal.parseArgs({ ...ok, pull_number: 0 })).toThrow(/pull_number/);
      expect(() => _internal.parseArgs({ ...ok, pull_number: 'x' })).toThrow(/pull_number/);
      expect(() => _internal.parseArgs({ repo: 'a/b' })).toThrow(/pull_number/);
    });

    test('rejects when neither title nor body provided', () => {
      expect(() => _internal.parseArgs({ repo: 'a/b', pull_number: 1 })).toThrow(
        /at least one of title or body/,
      );
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
        githubUpdatePr.invoke({ repo: 'a/b', pull_number: 1, title: 'T' }, CTX),
      ).rejects.toThrow(/GITHUB_TOKEN.*not set/);
    });
  });
});

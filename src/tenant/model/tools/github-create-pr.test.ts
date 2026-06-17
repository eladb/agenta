import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _internal, githubCreatePr } from './github-create-pr';

const CTX = { threadKey: 'unit-test' };

describe('github_create_pr', () => {
  describe('parseArgs', () => {
    const ok = {
      repo: 'owner/name',
      head_branch: 'claude/x',
      title: 'T',
      patch_path: '/tmp/p.diff',
    };
    test('accepts minimum required fields, defaults base/body/commit_message/draft', () => {
      const r = _internal.parseArgs(ok);
      expect(r.base).toBe('main');
      expect(r.body).toBe('');
      expect(r.commit_message).toBe('T');
      expect(r.draft).toBe(false);
    });

    test('rejects malformed repo', () => {
      expect(() => _internal.parseArgs({ ...ok, repo: 'just-a-name' })).toThrow(
        /repo.*owner\/name/,
      );
      expect(() => _internal.parseArgs({ ...ok, repo: 'a/b/c' })).toThrow(/repo.*owner\/name/);
    });

    test('requires head_branch, title, patch_path', () => {
      expect(() => _internal.parseArgs({ ...ok, head_branch: '' })).toThrow(/head_branch/);
      expect(() => _internal.parseArgs({ ...ok, title: '' })).toThrow(/title/);
      expect(() => _internal.parseArgs({ ...ok, patch_path: '' })).toThrow(/patch_path/);
    });

    test('commit_message defaults to title', () => {
      expect(_internal.parseArgs({ ...ok, commit_message: 'CM' }).commit_message).toBe('CM');
      expect(_internal.parseArgs({ ...ok }).commit_message).toBe('T');
    });

    test('draft is strict equality on true', () => {
      expect(_internal.parseArgs({ ...ok, draft: 'true' }).draft).toBe(false);
      expect(_internal.parseArgs({ ...ok, draft: 1 }).draft).toBe(false);
      expect(_internal.parseArgs({ ...ok, draft: true }).draft).toBe(true);
    });

    test('submodule_updates defaults to empty array', () => {
      expect(_internal.parseArgs(ok).submodule_updates).toEqual([]);
    });

    test('submodule_updates accepts valid {path, sha} entries', () => {
      const sha = 'a'.repeat(40);
      const r = _internal.parseArgs({
        ...ok,
        submodule_updates: [{ path: 'vendor/x', sha }],
      });
      expect(r.submodule_updates).toEqual([{ path: 'vendor/x', sha }]);
    });

    test('submodule_updates rejects malformed SHAs', () => {
      expect(() =>
        _internal.parseArgs({ ...ok, submodule_updates: [{ path: 'p', sha: 'short' }] }),
      ).toThrow(/40-char.*hex/);
      expect(() =>
        _internal.parseArgs({
          ...ok,
          submodule_updates: [{ path: 'p', sha: `${'a'.repeat(39)}Z` }],
        }),
      ).toThrow(/40-char.*hex/);
      // uppercase hex rejected — git emits lowercase, keep contract tight
      expect(() =>
        _internal.parseArgs({ ...ok, submodule_updates: [{ path: 'p', sha: 'A'.repeat(40) }] }),
      ).toThrow(/40-char.*hex/);
    });

    test('submodule_updates rejects empty/non-string path', () => {
      const sha = 'a'.repeat(40);
      expect(() => _internal.parseArgs({ ...ok, submodule_updates: [{ path: '', sha }] })).toThrow(
        /path.*non-empty/,
      );
      expect(() => _internal.parseArgs({ ...ok, submodule_updates: [{ path: 123, sha }] })).toThrow(
        /path.*non-empty/,
      );
    });

    test('submodule_updates must be an array', () => {
      expect(() => _internal.parseArgs({ ...ok, submodule_updates: 'nope' })).toThrow(
        /submodule_updates.*array/,
      );
    });
  });

  describe('tokenizedUrl', () => {
    test('builds https URL with the token as user', () => {
      expect(_internal.tokenizedUrl('owner/repo', 'ghp_xyz')).toBe(
        'https://x-access-token:ghp_xyz@github.com/owner/repo.git',
      );
    });
    test('URL-encodes token chars that would break the URL', () => {
      expect(_internal.tokenizedUrl('o/r', 'a@b:c/d')).toBe(
        'https://x-access-token:a%40b%3Ac%2Fd@github.com/o/r.git',
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
        githubCreatePr.invoke(
          {
            repo: 'a/b',
            head_branch: 'claude/x',
            title: 'T',
            patch_path: '/tmp/p.diff',
          },
          CTX,
        ),
      ).rejects.toThrow(/GITHUB_TOKEN.*not set/);
    });
  });
});

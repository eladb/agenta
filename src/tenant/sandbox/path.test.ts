import { describe, expect, test } from 'bun:test';
import { normalizeSandboxPath } from './index';

describe('normalizeSandboxPath (#336)', () => {
  test('expands a leading ~/ to the sandbox home', () => {
    expect(normalizeSandboxPath('~/foo/bar.nacl')).toBe('/home/sandbox/foo/bar.nacl');
  });
  test('bare ~ and ~/ are the home', () => {
    expect(normalizeSandboxPath('~')).toBe('/home/sandbox');
    expect(normalizeSandboxPath('~/')).toBe('/home/sandbox');
  });
  test('relative paths anchor at the home', () => {
    expect(normalizeSandboxPath('foo/bar.nacl')).toBe('/home/sandbox/foo/bar.nacl');
    expect(normalizeSandboxPath('./foo')).toBe('/home/sandbox/foo');
  });
  test('absolute paths pass through untouched', () => {
    expect(normalizeSandboxPath('/home/sandbox/foo')).toBe('/home/sandbox/foo');
    expect(normalizeSandboxPath('/etc/hosts')).toBe('/etc/hosts');
  });
  test('a path with spaces survives (the "My First Env" case)', () => {
    expect(normalizeSandboxPath('~/envs/My First Env/x.nacl')).toBe(
      '/home/sandbox/envs/My First Env/x.nacl',
    );
  });
});

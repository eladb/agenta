import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saltoCli } from './salto-cli';

const CTX = { threadKey: 'unit-test' };

describe('salto_cli', () => {
  test('describe() is safe on null/empty args', () => {
    expect(() => saltoCli.describe?.(null)).not.toThrow();
    expect(saltoCli.describe?.(null)).toBe('salto-cloud (no args)');
    expect(saltoCli.describe?.({})).toBe('salto-cloud (no args)');
    expect(saltoCli.describe?.({ args: [] })).toBe('salto-cloud (no args)');
  });

  test('describe() flattens args into a single-line preview, truncated at 60 chars', () => {
    expect(saltoCli.describe?.({ args: ['deployment', 'show', '-i', 'dep_123'] })).toBe(
      'salto-cloud deployment show -i dep_123',
    );
    const long = saltoCli.describe?.({ args: ['x'.repeat(80)] }) ?? '';
    expect(long.endsWith('…')).toBe(true);
    expect(long.includes('\n')).toBe(false);
  });

  test('invoke rejects missing args', async () => {
    await expect(saltoCli.invoke({}, CTX)).rejects.toThrow(/args.*required/);
  });

  test('invoke rejects non-string entries in args', async () => {
    await expect(saltoCli.invoke({ args: ['ok', 42] }, CTX)).rejects.toThrow(/string/);
  });

  describe('SALTO_API_TOKEN guard', () => {
    const PREV = process.env.SALTO_API_TOKEN;
    beforeEach(() => {
      delete process.env.SALTO_API_TOKEN;
    });
    afterEach(() => {
      if (PREV === undefined) delete process.env.SALTO_API_TOKEN;
      else process.env.SALTO_API_TOKEN = PREV;
    });

    test('throws clearly when SALTO_API_TOKEN is unset', async () => {
      await expect(saltoCli.invoke({ args: ['--version'] }, CTX)).rejects.toThrow(
        /SALTO_API_TOKEN.*not set/,
      );
    });
  });
});

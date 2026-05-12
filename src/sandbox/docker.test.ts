import { describe, expect, test } from 'bun:test';
import { containerName } from './docker';

describe('containerName', () => {
  test('prefixes threadKey with agenta-', () => {
    expect(containerName('c0b307lp274__1778528349_050239')).toBe(
      'agenta-c0b307lp274__1778528349_050239',
    );
  });

  test('different threadKeys produce different names', () => {
    expect(containerName('a')).not.toBe(containerName('b'));
  });
});

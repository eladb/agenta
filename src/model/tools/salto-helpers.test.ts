import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';

describe('deploymentIdentifierArgs', () => {
  test('returns -i + id when only deployment_id is provided', () => {
    expect(deploymentIdentifierArgs({ deployment_id: 'dep_123' })).toEqual(['-i', 'dep_123']);
  });

  test('returns -b + branch when only branch_name is provided', () => {
    expect(deploymentIdentifierArgs({ branch_name: 'feat/x' })).toEqual(['-b', 'feat/x']);
  });

  test('throws when neither is provided', () => {
    expect(() => deploymentIdentifierArgs({})).toThrow(/either deployment_id or branch_name/);
  });

  test('throws when both are provided', () => {
    expect(() =>
      deploymentIdentifierArgs({ deployment_id: 'd', branch_name: 'b' }),
    ).toThrow(/only one of/);
  });

  test('treats empty strings as absent', () => {
    expect(() => deploymentIdentifierArgs({ deployment_id: '', branch_name: '' })).toThrow(
      /either deployment_id or branch_name/,
    );
    expect(deploymentIdentifierArgs({ deployment_id: '', branch_name: 'b' })).toEqual(['-b', 'b']);
  });
});

describe('deploymentIdentifierLabel', () => {
  test('prefers id over branch when both present (even though args validator rejects)', () => {
    expect(deploymentIdentifierLabel({ deployment_id: 'd', branch_name: 'b' })).toBe('id=d');
  });
  test('falls back to ? when nothing present', () => {
    expect(deploymentIdentifierLabel({})).toBe('?');
  });
  test('shows branch when only branch present', () => {
    expect(deploymentIdentifierLabel({ branch_name: 'feat/x' })).toBe('branch=feat/x');
  });
});

describe('formatSaltoResult', () => {
  test('formats stdout + stderr + exit code in a stable shape', () => {
    const out = formatSaltoResult({ stdout: 'hi\n', stderr: 'warn\n', code: 0 });
    expect(out).toBe('exit 0\n--- stdout ---\nhi\n--- stderr ---\nwarn');
  });
  test('truncates large output past 16KB', () => {
    const big = 'x'.repeat(20_000);
    const out = formatSaltoResult({ stdout: big, stderr: '', code: 1 });
    expect(out.length).toBeLessThan(big.length + 200);
    expect(out).toMatch(/truncated \d+ chars/);
  });
});

describe('runSaltoCloud', () => {
  const PREV_TOKEN = process.env.SALTO_API_TOKEN;
  beforeEach(() => {
    delete process.env.SALTO_API_TOKEN;
  });
  afterEach(() => {
    if (PREV_TOKEN === undefined) delete process.env.SALTO_API_TOKEN;
    else process.env.SALTO_API_TOKEN = PREV_TOKEN;
  });

  test('throws clearly when SALTO_API_TOKEN is unset', async () => {
    await expect(runSaltoCloud(['deployment', 'show', '-i', 'x'])).rejects.toThrow(
      /SALTO_API_TOKEN.*not set/,
    );
  });
});

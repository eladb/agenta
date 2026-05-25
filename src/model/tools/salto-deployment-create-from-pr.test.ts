import { describe, expect, test } from 'bun:test';
import { saltoDeploymentCreateFromPr } from './salto-deployment-create-from-pr';

const t = saltoDeploymentCreateFromPr;

describe('salto_deployment_create_from_pr', () => {
  test('describe() handles empty args without throwing', () => {
    expect(() => t.describe?.({})).not.toThrow();
    expect(t.describe?.({})).toBe('salto deployment create from-pr env=? pr=?');
  });

  test('describe() shortens pr_url and prefers target_env_id', () => {
    expect(
      t.describe?.({
        pr_url: 'https://github.com/owner/repo/pull/12',
        target_env_id: 'env_uuid_abc',
      }),
    ).toBe('salto deployment create from-pr env=env_uuid_abc pr=owner/repo/pull/12');
  });

  test('invoke rejects missing pr_url', async () => {
    await expect(t.invoke({}, { threadKey: 'tk' })).rejects.toThrow(/pr_url/);
  });

  test('invoke rejects missing env', async () => {
    await expect(t.invoke({ pr_url: 'x' }, { threadKey: 'tk' })).rejects.toThrow(
      /target_env or target_env_id/,
    );
  });

  test('invoke rejects both env + env_id', async () => {
    await expect(
      t.invoke({ pr_url: 'x', target_env: 'a', target_env_id: 'b' }, { threadKey: 'tk' }),
    ).rejects.toThrow(/only one/);
  });
});

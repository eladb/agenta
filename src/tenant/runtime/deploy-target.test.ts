import { describe, expect, it } from 'bun:test';
import { resolveDeployTarget } from './deploy-target';

describe('resolveDeployTarget', () => {
  it('defaults to fly when env var is unset (regression-proofs the default)', () => {
    expect(resolveDeployTarget({})).toBe('fly');
  });

  it('defaults to fly when env var is the empty string', () => {
    expect(resolveDeployTarget({ AGENTA_DEPLOY_TARGET: '' })).toBe('fly');
  });

  it('returns fly when AGENTA_DEPLOY_TARGET=fly (identical to unset)', () => {
    expect(resolveDeployTarget({ AGENTA_DEPLOY_TARGET: 'fly' })).toBe('fly');
  });

  it('returns ecs when AGENTA_DEPLOY_TARGET=ecs', () => {
    expect(resolveDeployTarget({ AGENTA_DEPLOY_TARGET: 'ecs' })).toBe('ecs');
  });

  it('throws on any other value (catches typos like "Fly" or "aws")', () => {
    expect(() => resolveDeployTarget({ AGENTA_DEPLOY_TARGET: 'Fly' })).toThrow(
      /AGENTA_DEPLOY_TARGET/,
    );
    expect(() => resolveDeployTarget({ AGENTA_DEPLOY_TARGET: 'aws' })).toThrow(
      /AGENTA_DEPLOY_TARGET/,
    );
  });
});

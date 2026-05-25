import { formatSaltoResult, runSaltoCloud } from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentCreateFromPr: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_create_from_pr',
      description:
        'Create a new Salto deployment from a GitHub pull request URL. Provide exactly one of target_env (env name) OR target_env_id (env UUID). pr_url is required.',
      parameters: {
        type: 'object',
        properties: {
          pr_url: { type: 'string', description: 'Full GitHub pull request URL' },
          target_env: {
            type: 'string',
            description: 'Target environment name (mutually exclusive with target_env_id)',
          },
          target_env_id: {
            type: 'string',
            description:
              'Target environment UUID — preferred over target_env when names may collide across orgs (mutually exclusive with target_env)',
          },
          account: {
            type: 'string',
            description: 'Target Netsuite/Salesforce account name (optional)',
          },
          skip_wait: {
            type: 'boolean',
            description: 'If true, return immediately after queuing instead of waiting for deployment calculation',
          },
        },
        required: ['pr_url'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const a = (args && typeof args === 'object' ? args : {}) as {
      pr_url?: unknown;
      target_env?: unknown;
      target_env_id?: unknown;
    };
    const env =
      (typeof a.target_env_id === 'string' && a.target_env_id) ||
      (typeof a.target_env === 'string' && a.target_env) ||
      '?';
    const pr =
      typeof a.pr_url === 'string' ? a.pr_url.replace(/^https?:\/\/github\.com\//, '') : '?';
    return `salto deployment create from-pr env=${env} pr=${pr}`;
  },
  invoke: async (args, _ctx, signal) => {
    const a = (args && typeof args === 'object' ? args : {}) as {
      pr_url?: unknown;
      target_env?: unknown;
      target_env_id?: unknown;
      account?: unknown;
      skip_wait?: unknown;
    };
    if (typeof a.pr_url !== 'string' || a.pr_url.length === 0) {
      throw new Error('pr_url is required');
    }
    const env = typeof a.target_env === 'string' && a.target_env.length > 0 ? a.target_env : undefined;
    const envId =
      typeof a.target_env_id === 'string' && a.target_env_id.length > 0 ? a.target_env_id : undefined;
    if (!env && !envId) throw new Error('provide either target_env or target_env_id');
    if (env && envId) throw new Error('provide only one of target_env or target_env_id (not both)');
    const cli: string[] = ['deployment', 'create', 'from-pull-request', '-u', a.pr_url];
    if (envId) cli.push('-E', envId);
    else if (env) cli.push('-e', env);
    if (typeof a.account === 'string' && a.account.length > 0) cli.push('-a', a.account);
    if (a.skip_wait === true) cli.push('-g');
    const r = await runSaltoCloud(cli, signal);
    return formatSaltoResult(r);
  },
};

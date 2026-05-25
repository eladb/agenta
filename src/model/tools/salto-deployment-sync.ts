import {
  DEPLOYMENT_IDENTIFIER_PROPERTIES,
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentSync: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_sync',
      description:
        'Sync a Salto deployment by pulling new commits and syncing target changes. Identify by exactly one of deployment_id OR branch_name.',
      parameters: {
        type: 'object',
        properties: {
          ...DEPLOYMENT_IDENTIFIER_PROPERTIES,
          skip_wait: {
            type: 'boolean',
            description: 'If true, return immediately after queuing the sync instead of waiting for calculation',
          },
        },
        additionalProperties: false,
      },
    },
  },
  describe: (args) => `salto deployment sync ${deploymentIdentifierLabel(args)}`,
  invoke: async (args, _ctx, signal) => {
    const a = (args && typeof args === 'object' ? args : {}) as { skip_wait?: unknown };
    const cli: string[] = ['deployment', 'sync', ...deploymentIdentifierArgs(args)];
    if (a.skip_wait === true) cli.push('-g');
    const r = await runSaltoCloud(cli, signal);
    return formatSaltoResult(r);
  },
};

import {
  DEPLOYMENT_IDENTIFIER_PROPERTIES,
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentValidate: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_validate',
      description:
        'Validate the changes in a Salto deployment (Salesforce target environments only). Read-only — no actual deploy. Identify by exactly one of deployment_id OR branch_name.',
      parameters: {
        type: 'object',
        properties: {
          ...DEPLOYMENT_IDENTIFIER_PROPERTIES,
          fail_on_unpulled_commits: {
            type: 'boolean',
            description: 'If true, disable the auto-pull and fail when remote has new commits',
          },
          config: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of validation config params in CLI format (e.g. ["foo=bar", "baz=qux"])',
          },
        },
        additionalProperties: false,
      },
    },
  },
  describe: (args) => `salto deployment validate ${deploymentIdentifierLabel(args)}`,
  invoke: async (args, _ctx, signal) => {
    const a = (args && typeof args === 'object' ? args : {}) as {
      fail_on_unpulled_commits?: unknown;
      config?: unknown;
    };
    const cli: string[] = ['deployment', 'validate', ...deploymentIdentifierArgs(args)];
    if (a.fail_on_unpulled_commits === true) cli.push('-u');
    if (Array.isArray(a.config)) {
      for (const c of a.config) {
        if (typeof c !== 'string' || c.length === 0) continue;
        cli.push('-C', c);
      }
    }
    const r = await runSaltoCloud(cli, signal);
    return formatSaltoResult(r);
  },
};

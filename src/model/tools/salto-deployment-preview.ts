import {
  DEPLOYMENT_IDENTIFIER_PROPERTIES,
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentPreview: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_preview',
      description:
        'Show the deployment plan (what would change if deployed). Read-only, no SaaS side effects. Identify the deployment by exactly one of deployment_id OR branch_name.',
      parameters: {
        type: 'object',
        properties: {
          ...DEPLOYMENT_IDENTIFIER_PROPERTIES,
          allow_warnings: {
            type: 'boolean',
            description: 'If true, treat warnings in the plan as non-fatal',
          },
          fail_on_unpulled_commits: {
            type: 'boolean',
            description: 'If true, disable the auto-pull and fail when remote has new commits',
          },
        },
        additionalProperties: false,
      },
    },
  },
  describe: (args) => `salto deployment preview ${deploymentIdentifierLabel(args)}`,
  invoke: async (args, _ctx, signal) => {
    const a = (args && typeof args === 'object' ? args : {}) as {
      allow_warnings?: unknown;
      fail_on_unpulled_commits?: unknown;
    };
    const cli: string[] = ['deployment', 'preview', ...deploymentIdentifierArgs(args)];
    if (a.allow_warnings === true) cli.push('-w');
    if (a.fail_on_unpulled_commits === true) cli.push('-u');
    const r = await runSaltoCloud(cli, signal);
    return formatSaltoResult(r);
  },
};

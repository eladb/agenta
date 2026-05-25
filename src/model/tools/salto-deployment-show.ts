import {
  DEPLOYMENT_IDENTIFIER_PROPERTIES,
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentShow: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_show',
      description:
        'Print details of a Salto deployment (name, description, status). Runs on the bot host using SALTO_API_TOKEN. Identify the deployment by exactly one of deployment_id OR branch_name.',
      parameters: {
        type: 'object',
        properties: DEPLOYMENT_IDENTIFIER_PROPERTIES,
        additionalProperties: false,
      },
    },
  },
  describe: (args) => `salto deployment show ${deploymentIdentifierLabel(args)}`,
  invoke: async (args, _ctx, signal) => {
    const idArgs = deploymentIdentifierArgs(args);
    const r = await runSaltoCloud(['deployment', 'show', ...idArgs], signal);
    return formatSaltoResult(r);
  },
};

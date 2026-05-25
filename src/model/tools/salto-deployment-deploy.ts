import {
  DEPLOYMENT_IDENTIFIER_PROPERTIES,
  deploymentIdentifierArgs,
  deploymentIdentifierLabel,
  formatSaltoResult,
  runSaltoCloud,
} from './salto-helpers';
import type { Tool } from './types';

export const saltoDeploymentDeploy: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'salto_deployment_deploy',
      description:
        'Deploy the changes in a Salto deployment to its target environment. Has SaaS side effects — only call after the user has explicitly approved the plan (typically reviewed via salto_deployment_preview). Identify by exactly one of deployment_id OR branch_name.',
      parameters: {
        type: 'object',
        properties: {
          ...DEPLOYMENT_IDENTIFIER_PROPERTIES,
          push: {
            type: 'boolean',
            description: 'If true, also push deployed elements back to git after a successful deploy',
          },
          deploy_on_behalf: {
            type: 'boolean',
            description: 'If true, deploy on behalf of the deployment owner (requires elevated permissions)',
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
  describe: (args) => `salto deployment DEPLOY ${deploymentIdentifierLabel(args)}`,
  invoke: async (args, _ctx, signal) => {
    const a = (args && typeof args === 'object' ? args : {}) as {
      push?: unknown;
      deploy_on_behalf?: unknown;
      fail_on_unpulled_commits?: unknown;
    };
    const cli: string[] = ['deployment', 'deploy', ...deploymentIdentifierArgs(args)];
    if (a.push === true) cli.push('-p');
    if (a.deploy_on_behalf === true) cli.push('-o');
    if (a.fail_on_unpulled_commits === true) cli.push('-u');
    const r = await runSaltoCloud(cli, signal);
    return formatSaltoResult(r);
  },
};

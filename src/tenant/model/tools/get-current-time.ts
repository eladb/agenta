import type { Tool } from './types';

export const getCurrentTime: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Returns the current UTC time as an ISO-8601 string.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  describe: () => 'get current time',
  invoke: async () => new Date().toISOString(),
};

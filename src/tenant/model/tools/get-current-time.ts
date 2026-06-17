import type { Tool } from './types';

export const getCurrentTime: Tool = {
  name: 'get_current_time',
  description: 'Returns the current UTC time as an ISO-8601 string.',
  params: { type: 'object', properties: {}, additionalProperties: false },
  invoke: async () => new Date().toISOString(),
};

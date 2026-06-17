import { strArg } from './helpers';
import type { Tool } from './types';

const BODY_CAP = 8 * 1024;
const TIMEOUT_MS = 10_000;

export const fetchUrl: Tool = {
  name: 'fetch_url',
  description: 'HTTP GET the given URL and return the response body (truncated to 8 KB).',
  params: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The URL to GET' } },
    required: ['url'],
    additionalProperties: false,
  },
  invoke: async (args, _ctx, signal) => {
    const url = strArg(args, 'url');
    if (!url) throw new Error('fetch_url: missing or invalid url');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      const text = await res.text();
      const body =
        text.length > BODY_CAP
          ? `${text.slice(0, BODY_CAP)}\n…[truncated ${text.length - BODY_CAP} chars]`
          : text;
      return `HTTP ${res.status}\n\n${body}`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

import { oneLine, strArg, truncate } from './helpers';
import type { Tool } from './types';

const TIMEOUT_MS = 15_000;
const CONTENT_CAP = 16 * 1024;
const TAVILY_URL = 'https://api.tavily.com/extract';

type TavilyResult = { url?: unknown; raw_content?: unknown };
type TavilyFailed = { url?: unknown; error?: unknown };

export const readPage: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'read_page',
      description:
        'Extract the main article text from a web page via Tavily Extract. Returns {url, content} with content truncated to 16 KB. Use for full-article reads; use fetch_url for raw bytes / JSON.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to extract' },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const url = strArg(args, 'url');
    return url ? `read_page: ${oneLine(url, 60)}` : 'read_page (no url)';
  },
  invoke: async (args, _ctx, signal) => {
    const url = strArg(args, 'url');
    if (!url) throw new Error('read_page: missing or invalid url');

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return 'tavily error: TAVILY_API_KEY not set';

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(TAVILY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          urls: [url],
          extract_depth: 'basic',
          include_images: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return `tavily error: ${res.status}`;
      const data = (await res.json()) as {
        results?: TavilyResult[];
        failed_results?: TavilyFailed[];
      };
      const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
      const failedForUrl = failed.find((f) => f.url === url);
      if (failedForUrl) {
        const reason =
          typeof failedForUrl.error === 'string' && failedForUrl.error.length > 0
            ? failedForUrl.error
            : 'unknown';
        return `read_page failed: ${reason}`;
      }
      const results = Array.isArray(data.results) ? data.results : [];
      const hit = results.find((r) => r.url === url) ?? results[0];
      if (!hit) return 'read_page failed: no result';
      const raw = typeof hit.raw_content === 'string' ? hit.raw_content : '';
      const content = truncate(raw, CONTENT_CAP, 'page');
      return JSON.stringify({ url, content });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

import { oneLine, strArg, truncate } from './helpers';
import type { Tool } from './types';

const TIMEOUT_MS = 10_000;
const SNIPPET_CAP = 280;
const DEFAULT_MAX_RESULTS = 5;
const HARD_MAX_RESULTS = 10;
const TAVILY_URL = 'https://api.tavily.com/search';

type TavilyResult = { title?: unknown; url?: unknown; content?: unknown };

export const webSearch: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Web search via Tavily. Returns a list of {title, url, snippet} results for the given query. Use fetch_url to read a specific result in full.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: {
            type: 'number',
            description: `Maximum number of results (default ${DEFAULT_MAX_RESULTS}, cap ${HARD_MAX_RESULTS})`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  describe: (args) => {
    const q = strArg(args, 'query');
    return q ? `web_search: ${oneLine(q, 60)}` : 'web_search (no query)';
  },
  invoke: async (args, _ctx, signal) => {
    const query = strArg(args, 'query');
    if (!query) throw new Error('web_search: missing or invalid query');
    const rawMax = (args as Record<string, unknown> | null)?.max_results;
    const max =
      typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(Math.floor(rawMax), HARD_MAX_RESULTS)
        : DEFAULT_MAX_RESULTS;

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
          query,
          max_results: max,
          search_depth: 'basic',
          include_answer: false,
          include_raw_content: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) return `tavily error: ${res.status}`;
      const data = (await res.json()) as { results?: TavilyResult[] };
      const results = Array.isArray(data.results) ? data.results : [];
      const mapped = results.map((r) => ({
        title: typeof r.title === 'string' ? r.title : '',
        url: typeof r.url === 'string' ? r.url : '',
        snippet: typeof r.content === 'string' ? truncate(r.content, SNIPPET_CAP, 'snippet') : '',
      }));
      return JSON.stringify({ results: mapped });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

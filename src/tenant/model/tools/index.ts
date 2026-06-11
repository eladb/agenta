import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { log } from '../../../shared/log';
import type { ToolDef } from '../gateway';
import { askUser } from './ask-user';
import { bash, formatBashResult } from './bash';
import { editFileTool } from './edit-file';
import { fetchUrl } from './fetch-url';
import { getCurrentTime } from './get-current-time';
import { githubCreatePr } from './github-create-pr';
import { githubPrComment } from './github-pr-comment';
import { githubUpdatePr } from './github-update-pr';
import { glob } from './glob';
import { grep } from './grep';
import { readFileTool } from './read-file';
import { readPage } from './read-page';
import { shareFile } from './share-file';
import type { Tool, ToolContext, ToolProgressChunk } from './types';
import { webSearch } from './web-search';
import { writeFileTool } from './write-file';

// Re-exports — callers (turn.ts, tests) import these from '../model/tools'.
export type { Tool, ToolContext, ToolProgressChunk };
export { formatBashResult };

// Tool registry. Keys must match each tool's def.function.name — TOOL_DEFS
// is derived from the values, and invokeTool looks up by the key the model
// emits in its tool_call.function.name.
export const TOOLS: Record<string, Tool> = {
  get_current_time: getCurrentTime,
  fetch_url: fetchUrl,
  read_page: readPage,
  bash,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  grep,
  glob,
  ask_user: askUser,
  share_file: shareFile,
  web_search: webSearch,
  github_create_pr: githubCreatePr,
  github_update_pr: githubUpdatePr,
  github_pr_comment: githubPrComment,
};

// Live ESM binding consumed by turn.ts. `let` (not `const`) so the extra-tools
// loader can recompute it after registering overlay tools; ESM named exports
// are live, so turn.ts sees the refreshed array without re-importing.
export let TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map((t) => t.def);

// Validates one candidate against the same contract _registry.test.ts enforces
// for built-ins. Throws on any problem so a broken overlay fails boot loudly
// rather than registering a half-broken tool.
function assertValidTool(tool: unknown, source: string): asserts tool is Tool {
  if (!tool || typeof tool !== 'object') {
    throw new Error(`extra tool from ${source} is not an object`);
  }
  const t = tool as Partial<Tool>;
  const name = t.def?.function?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`extra tool from ${source} has no def.function.name`);
  }
  if (typeof t.invoke !== 'function') {
    throw new Error(`extra tool '${name}' from ${source} has no invoke() function`);
  }
  if (typeof t.describe !== 'function') {
    throw new Error(`extra tool '${name}' from ${source} has no describe() function`);
  }
  let described: unknown;
  try {
    described = t.describe({});
  } catch (err) {
    throw new Error(
      `extra tool '${name}' from ${source} describe() threw: ${(err as Error).message}`,
    );
  }
  if (typeof described !== 'string' || described.length === 0 || described.includes('\n')) {
    throw new Error(
      `extra tool '${name}' from ${source} describe() must return a non-empty single-line string`,
    );
  }
}

// Scans every directory named in AGENTA_EXTRA_TOOLS (comma-separated) for
// `*.ts`/`*.js` modules, dynamic-imports each, and registers its default
// export (a Tool or Tool[]) alongside the built-ins. Validates every tool and
// throws on the first problem — a name colliding with a built-in or another
// extra tool is an error, never a silent override. Unset env ⇒ no-op (built-ins
// only). Call once at tenant boot before any turn runs; it mutates TOOLS in
// place and recomputes TOOL_DEFS.
export async function registerExtraTools(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const raw = env.AGENTA_EXTRA_TOOLS;
  if (!raw || raw.trim().length === 0) return;
  const dirs = raw
    .split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  for (const dir of dirs) {
    const abs = resolve(dir);
    let entries: string[];
    try {
      entries = await readdir(abs);
    } catch (err) {
      throw new Error(`AGENTA_EXTRA_TOOLS dir '${abs}' is not readable: ${(err as Error).message}`);
    }
    const modules = entries.filter((f) => f.endsWith('.ts') || f.endsWith('.js')).sort();
    for (const file of modules) {
      const path = resolve(abs, file);
      let mod: { default?: unknown };
      try {
        mod = await import(path);
      } catch (err) {
        throw new Error(`failed to import extra tool module ${path}: ${(err as Error).message}`);
      }
      const exported = mod.default;
      if (exported === undefined) {
        throw new Error(`extra tool module ${path} has no default export`);
      }
      const candidates = Array.isArray(exported) ? exported : [exported];
      for (const candidate of candidates) {
        assertValidTool(candidate, path);
        const name = candidate.def.function.name;
        if (name in TOOLS) {
          throw new Error(`extra tool '${name}' from ${path} collides with an existing tool`);
        }
        TOOLS[name] = candidate;
        log.info('tools', `registered extra tool '${name}' from ${path}`);
      }
    }
  }

  TOOL_DEFS = Object.values(TOOLS).map((t) => t.def);
}

export async function invokeTool(
  name: string,
  argumentsJson: string,
  ctx: ToolContext,
  signal?: AbortSignal,
): Promise<{ content: string; error: boolean }> {
  const tool = TOOLS[name];
  if (!tool) return { content: `error: unknown tool '${name}'`, error: true };
  let args: unknown;
  try {
    args = argumentsJson.length > 0 ? JSON.parse(argumentsJson) : {};
  } catch (err) {
    return { content: `error: invalid JSON arguments: ${(err as Error).message}`, error: true };
  }
  try {
    const content = await tool.invoke(args, ctx, signal);
    return { content, error: false };
  } catch (err) {
    return { content: `error: ${(err as Error).message}`, error: true };
  }
}

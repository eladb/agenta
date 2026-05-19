import type { ToolDef } from '../gateway';
import { askUser } from './ask-user';
import { bash, formatBashResult } from './bash';
import { editFileTool } from './edit-file';
import { fetchUrl } from './fetch-url';
import { getCurrentTime } from './get-current-time';
import { glob } from './glob';
import { grep } from './grep';
import { listDirTool } from './list-dir';
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
  list_dir: listDirTool,
  ask_user: askUser,
  share_file: shareFile,
  web_search: webSearch,
};

export const TOOL_DEFS: ToolDef[] = Object.values(TOOLS).map((t) => t.def);

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

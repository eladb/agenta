import type { WebClient } from '@slack/web-api';

export type ToolProgressChunk = { kind: 'stdout' | 'stderr'; text: string };

// Context passed to every tool invocation. Tools take what they need and
// ignore the rest. threadKey is the only field every tool can rely on.
export type ToolContext = {
  threadKey: string;
  onProgress?: (chunk: ToolProgressChunk) => void;
  // Slack hooks — only set during real Slack-backed turns; e2e tests that
  // exercise non-Slack tools (sandbox, fs, time) can omit them.
  web?: WebClient;
  channel?: string;
  threadTs?: string;
  // The model's latest content text from this iteration. ask_user prepends it
  // above the interactive blocks so the user keeps the model's reasoning/
  // context visible alongside the choices.
  modelContent?: string;
};

// A tool the model can call. `params` is the JSON-Schema for the tool's
// arguments; `mcp-tools.ts` adapts each tool to the Claude Agent SDK's MCP
// tool registry at boot (the SDK is the only harness).
export type Tool = {
  name: string;
  description: string;
  params: object;
  invoke: (args: unknown, ctx: ToolContext, signal?: AbortSignal) => Promise<string>;
  // True if this tool touches the per-thread sandbox (bash, fs, share_file,
  // …). Used by the turn loop to await the in-flight ensureContainer (kicked
  // off in the background by handler.ts on turn start) and, if it's still
  // running, surface a "_waiting for workspace…_" line. Tools that never
  // call into the sandbox (get_current_time, fetch_url, ask_user) leave
  // this unset.
  requiresSandbox?: boolean;
};

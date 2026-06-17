import type { WebClient } from '@slack/web-api';

// OpenAI-style function tool definition. Each tool declares its name +
// JSON-Schema parameters in this shape; `mcp-tools.ts` adapts it to the
// Claude Agent SDK's MCP tool registry at boot (the SDK is the only harness).
export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

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
  // ts of the running checklist message. ask_user renders its interactive
  // blocks onto this message rather than posting a new one, so the question
  // appears inline with the turn's progress instead of out-of-order below
  // the final reply.
  checklistTs?: string;
  // The model's latest content text from this iteration (liveHeader in
  // turn.ts). ask_user prepends it above the interactive blocks so the
  // user keeps the model's reasoning/context visible alongside the
  // choices.
  modelContent?: string;
  // True under the `task_update` streaming display style (#285). There is no
  // editable checklist text message to render interactive blocks onto, and
  // the spec forbids interactive blocks mid-stream — so ask_user posts its
  // blocks as a SEPARATE thread message while the stream shows an "Asking…"
  // task row. Unset (falsy) in verbose/pretty mode: ask_user keeps editing
  // the checklist message in place.
  streamMode?: boolean;
};

export type Tool = {
  def: ToolDef;
  invoke: (args: unknown, ctx: ToolContext, signal?: AbortSignal) => Promise<string>;
  // Optional human-readable one-liner for the Slack checklist. Receives the
  // parsed JSON args (or {} if parsing failed). Must be short, safe to call
  // on malformed input, and not throw.
  describe?: (args: unknown) => string;
  // True if this tool touches the per-thread sandbox (bash, fs, share_file,
  // …). Used by the turn loop to await the in-flight ensureContainer (kicked
  // off in the background by handler.ts on turn start) and, if it's still
  // running, surface a "_waiting for workspace…_" line. Tools that never
  // call into the sandbox (get_current_time, fetch_url, ask_user) leave
  // this unset.
  requiresSandbox?: boolean;
};

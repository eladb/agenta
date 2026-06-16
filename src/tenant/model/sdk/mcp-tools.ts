import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { TOOLS } from '../tools';
import type { ToolContext } from '../tools/types';
import { jsonSchemaToZodShape } from './json-schema-to-zod';

// All TOOLS-registry tools are exposed through the SDK harness, including
// ask_user (#305, Phase 2): its invoke is self-contained (posts interactive
// blocks, registers a ≤1-per-thread ask, blocks until a click / same-thread
// text reply / timeout / abort resolves it) and needs no extra wiring here —
// runSdkTurn raises CLAUDE_CODE_STREAM_CLOSE_TIMEOUT so its human-time blocking
// doesn't drop the in-flight MCP call.
const EXCLUDED = new Set<string>([]);

// Build an in-process SDK MCP server ("agenta") wrapping every tool in the TOOLS
// registry except the excluded set. Each registry Tool becomes one SDK tool():
//   name        = def.function.name           (model sees `mcp__agenta__<name>`)
//   description = def.function.description
//   inputSchema = jsonSchemaToZodShape(def.function.parameters)
//   handler     = calls the existing Tool.invoke(args, ctxFactory(), signal)
//
// ctxFactory is called per invocation so each turn threads its own ToolContext
// (threadKey, Slack hooks, onProgress, streamMode) via closure. signal is the
// turn-level AbortSignal (/stop) forwarded to every tool.
export function buildAgentaMcpServer(
  ctxFactory: () => ToolContext,
  signal?: AbortSignal,
): ReturnType<typeof createSdkMcpServer> {
  const tools = Object.values(TOOLS)
    .filter((t) => !EXCLUDED.has(t.def.function.name))
    .map((t) => {
      const name = t.def.function.name;
      const shape = jsonSchemaToZodShape(t.def.function.parameters);
      return tool(name, t.def.function.description, shape, async (args: unknown) => {
        try {
          const text = await t.invoke(args, ctxFactory(), signal);
          return { content: [{ type: 'text' as const, text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text' as const, text: `error: ${message}` }],
            isError: true,
          };
        }
      });
    });

  return createSdkMcpServer({ name: 'agenta', version: '1.0.0', tools });
}

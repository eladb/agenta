import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { TOOLS } from '../tools';
import type { ToolContext } from '../tools/types';
import { jsonSchemaToZodShape } from './json-schema-to-zod';

// Tools NOT exposed through the SDK harness yet. ask_user is Phase 2 (#303 scope
// note): it needs the interactive-block / asks-registry plumbing the SDK turn
// doesn't wire up here.
const EXCLUDED = new Set(['ask_user']);

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

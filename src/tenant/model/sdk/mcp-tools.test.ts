import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOLS } from '../tools';
import type { Tool, ToolContext } from '../tools/types';
import { buildAgentaMcpServer } from './mcp-tools';

// Connect an in-memory MCP client to the server instance so we can list + call
// tools through the real SDK wiring (no model, no network, no sandbox).
async function connect(server: ReturnType<typeof buildAgentaMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

const noopCtx = (): ToolContext => ({ threadKey: 't1' });

describe('buildAgentaMcpServer — tool surface', () => {
  test('exposes the expected tool set including ask_user', async () => {
    const server = buildAgentaMcpServer(noopCtx);
    const client = await connect(server);
    const { tools } = await client.listTools();
    const names = new Set(tools.map((t) => t.name));

    for (const expected of [
      'bash',
      'read_file',
      'write_file',
      'edit_file',
      'share_file',
      'fetch_url',
      'get_current_time',
      // ask_user is now exposed (#305, Phase 2). The model sees it as
      // mcp__agenta__ask_user; the registry/SDK name is the bare 'ask_user'.
      'ask_user',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
    await client.close();
  });
});

describe('buildAgentaMcpServer — invocation routing', () => {
  const FAKE = 'fake_probe_tool';

  afterEach(() => {
    delete TOOLS[FAKE];
  });

  test('routes parsed args + ctxFactory()-supplied ctx through Tool.invoke', async () => {
    let seenArgs: unknown;
    let seenCtx: ToolContext | undefined;
    let seenSignal: AbortSignal | undefined;

    const fake: Tool = {
      def: {
        type: 'function',
        function: {
          name: FAKE,
          description: 'probe',
          parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      },
      describe: () => 'probe',
      invoke: async (args, ctx, signal) => {
        seenArgs = args;
        seenCtx = ctx;
        seenSignal = signal;
        return `got:${(args as { value: string }).value}`;
      },
    };
    TOOLS[FAKE] = fake;

    const ctx: ToolContext = { threadKey: 'thread-xyz' };
    const ac = new AbortController();
    const server = buildAgentaMcpServer(() => ctx, ac.signal);
    const client = await connect(server);

    const res = await client.callTool({ name: FAKE, arguments: { value: 'hello' } });

    // Tool.invoke received the parsed args + the ctx from ctxFactory + the signal.
    expect(seenArgs).toEqual({ value: 'hello' });
    expect(seenCtx).toBe(ctx);
    expect(seenSignal).toBe(ac.signal);

    // The string result is wrapped as { content: [{ type:'text', text }] }.
    expect(res.content).toEqual([{ type: 'text', text: 'got:hello' }]);
    expect(res.isError).toBeFalsy();

    await client.close();
  });

  test('a throwing tool surfaces as isError text', async () => {
    const boom: Tool = {
      def: {
        type: 'function',
        function: {
          name: FAKE,
          description: 'boom',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      describe: () => 'boom',
      invoke: async () => {
        throw new Error('kaboom');
      },
    };
    TOOLS[FAKE] = boom;

    const server = buildAgentaMcpServer(noopCtx);
    const client = await connect(server);
    const res = await client.callTool({ name: FAKE, arguments: {} });

    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'error: kaboom' }]);

    await client.close();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerExtraTools, TOOLS } from '../tools';
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
      name: FAKE,
      description: 'probe',
      params: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
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
      name: FAKE,
      description: 'boom',
      params: { type: 'object', properties: {}, additionalProperties: false },
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

// Phase 5 (#282): salto's overlay image adds tools via AGENTA_EXTRA_TOOLS. They
// must reach the model through the SDK harness exactly like the built-ins —
// proven end-to-end here: registerExtraTools scans a dir → TOOLS → the SDK MCP
// server exposes + invokes the overlay tool, with its richer schema (enum +
// optional) routed through the json-schema-to-zod shim.
describe('buildAgentaMcpServer — AGENTA_EXTRA_TOOLS overlay (Phase 5 / #282)', () => {
  const OVERLAY = 'salto_overlay_probe';
  let tmp: string | undefined;
  let savedEnv: string | undefined;

  afterEach(() => {
    // registerExtraTools mutates TOOLS; restore it so the overlay tool can't
    // leak into a later test's view.
    delete TOOLS[OVERLAY];
    if (savedEnv === undefined) delete process.env.AGENTA_EXTRA_TOOLS;
    else process.env.AGENTA_EXTRA_TOOLS = savedEnv;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  test('an overlay tool registered via AGENTA_EXTRA_TOOLS surfaces + runs on the SDK harness', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'agenta-overlay-'));
    // A realistic overlay tool: object params with an enum + an optional field,
    // so the shim is exercised beyond the simple-string built-ins.
    writeFileSync(
      join(tmp, 'deploy.ts'),
      `export default {
  name: '${OVERLAY}',
  description: 'Deploy the salto stack to an environment.',
  params: {
    type: 'object',
    properties: {
      env: { type: 'string', enum: ['dev', 'prod'], description: 'target env' },
      dry_run: { type: 'boolean', description: 'plan only' },
    },
    required: ['env'],
    additionalProperties: false,
  },
  invoke: async (args) => 'deployed to ' + args.env + (args.dry_run ? ' (dry-run)' : ''),
};
`,
    );

    savedEnv = process.env.AGENTA_EXTRA_TOOLS;
    process.env.AGENTA_EXTRA_TOOLS = tmp;
    await registerExtraTools();

    // It landed in the shared registry the SDK harness reads from...
    expect(TOOLS[OVERLAY]).toBeDefined();

    // ...and the SDK MCP server exposes it (bare name) + invokes it through the
    // same zod-shim path as the built-ins.
    const server = buildAgentaMcpServer(noopCtx);
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain(OVERLAY);

    const res = await client.callTool({
      name: OVERLAY,
      arguments: { env: 'prod', dry_run: true },
    });
    expect(res.content).toEqual([{ type: 'text', text: 'deployed to prod (dry-run)' }]);
    expect(res.isError).toBeFalsy();

    await client.close();
  });
});

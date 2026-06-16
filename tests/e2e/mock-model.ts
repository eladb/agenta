// A mock Anthropic Messages API server. Lets SDK-driven turns be driven
// deterministically in tests by pointing ANTHROPIC_BASE_URL at it instead of
// Bedrock (#303 decision #3). It speaks the real `/v1/messages` streaming SSE
// wire format so the official client / Agent SDK parses it as a genuine turn.
//
// Each POST /v1/messages consumes the next MockTurn (in order) and streams it
// back as a proper SSE event sequence.

export type MockToolUse = { id: string; name: string; input: unknown };

// One assistant response. `text` (optional) is emitted as a text block; each
// entry in `toolUses` (optional) is emitted as a tool_use block. A turn with any
// toolUses ends with stop_reason 'tool_use'; otherwise 'end_turn'.
export type MockTurn = { text?: string; toolUses?: MockToolUse[] };

type SseController = ReadableStreamDefaultController<Uint8Array>;

const enc = new TextEncoder();

// Anthropic SSE frames are `event: <name>\ndata: <json>\n\n`.
function sse(controller: SseController, event: string, data: unknown): void {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function streamTurn(controller: SseController, turn: MockTurn): void {
  const hasTools = Array.isArray(turn.toolUses) && turn.toolUses.length > 0;
  const msgId = `msg_${Math.random().toString(36).slice(2, 12)}`;

  // message_start — an empty message envelope; usage input filled, output 0.
  sse(controller, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: 'claude-mock',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });

  let index = 0;

  // Text block (if any).
  if (typeof turn.text === 'string' && turn.text.length > 0) {
    sse(controller, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    });
    sse(controller, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text: turn.text },
    });
    sse(controller, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  // tool_use blocks. The input arrives via input_json_delta as a JSON string
  // (partial_json); we send it in one chunk.
  for (const tu of turn.toolUses ?? []) {
    sse(controller, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: tu.id, name: tu.name, input: {} },
    });
    sse(controller, 'content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(tu.input ?? {}) },
    });
    sse(controller, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  // message_delta carries the terminal stop_reason + cumulative output usage.
  sse(controller, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: hasTools ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  sse(controller, 'message_stop', { type: 'message_stop' });
}

export async function startMockModel(turns: MockTurn[]): Promise<{
  baseUrl: string;
  stop: () => Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: recorded raw request bodies for assertions
  requests: any[];
}> {
  // biome-ignore lint/suspicious/noExplicitAny: recorded raw request bodies for assertions
  const requests: any[] = [];
  let cursor = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST' && url.pathname.endsWith('/v1/messages')) {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          body = undefined;
        }
        requests.push(body);

        const turn = turns[cursor] ?? turns[turns.length - 1] ?? { text: '' };
        cursor++;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streamTurn(controller, turn);
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    baseUrl,
    requests,
    stop: async () => {
      await server.stop(true);
    },
  };
}

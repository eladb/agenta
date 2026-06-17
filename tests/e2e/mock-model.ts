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

// A live handle to a running mock-model server. `startMockModel()` returns this.
//
// `setTurns` / `reset` make the server long-lived + per-test re-scriptable: the
// e2e bot+tenant boot once in `beforeAll`, but each test owns its own script.
// `gateNextTurn` arms a one-shot hold so the NEXT real turn stays open until the
// test releases it — the seam `/stop`-style tests need to send `/stop` while a
// turn is in flight.
export type MockModelHandle = {
  baseUrl: string;
  // Replace the active turn script. Turn selection still keys off conversation
  // progress (count of prior assistant messages), so a fresh thread / SDK
  // session re-walks the new turns from index 0.
  setTurns: (turns: MockTurn[]) => void;
  // Clear the recorded requests + the turn script (drop back to a single empty
  // text turn). Call between tests that share one server.
  reset: () => void;
  // Arm a one-shot gate: the next POST that would stream a real turn blocks
  // until `release()` is called. Lets a test catch a turn mid-flight (e.g. to
  // send `/stop`). Releasing streams the turn normally; if the SDK aborts the
  // request first the release is a harmless no-op. Only one gate may be armed
  // at a time.
  gateNextTurn: () => { release: () => void };
  // biome-ignore lint/suspicious/noExplicitAny: recorded raw request bodies for assertions
  requests: any[];
  stop: () => Promise<void>;
};

// `turns` is optional: omit it for the long-lived per-test-settable mode (script
// via `setTurns`); pass it for the original one-shot signature (back-compat for
// sdk-turn.test.ts / mock-model.test.ts).
export async function startMockModel(turns: MockTurn[] = []): Promise<MockModelHandle> {
  // Mutable script + recorded requests. Held in closure so `setTurns`/`reset`
  // re-point them without restarting the server.
  let script: MockTurn[] = turns;
  // biome-ignore lint/suspicious/noExplicitAny: recorded raw request bodies for assertions
  const requests: any[] = [];

  // One-shot gate. When armed, the next request that maps to a real turn awaits
  // `gate.promise` before streaming. `release()` resolves it and disarms.
  let gate: { promise: Promise<void>; release: () => void } | undefined;

  const server = Bun.serve({
    port: 0,
    // A gateNextTurn() hold keeps a response open until the test releases it,
    // which can exceed Bun's default 10s idle timeout (and slow docker-CI makes
    // it longer) — Bun would then kill the held connection mid-turn. Raise it to
    // the max (255s) so a gated turn survives.
    idleTimeout: 255,
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

        // Pick the turn by CONVERSATION PROGRESS, not a request counter. The
        // Messages API is stateless — every request carries the full `messages`
        // history — so the number of assistant messages already present is
        // exactly the number of model turns taken so far. The SDK subprocess
        // may issue extra/retried requests (warmup, transient retries) under CI
        // load; keying off a naive `cursor++` would let one of those shift every
        // turn (the original CI flake: a spurious request consumed turn 0, so the
        // real first turn got a text-only turn → no tool card → markdown at [0]).
        // Counting prior assistant turns is idempotent: a duplicated first
        // request (messages=[user]) maps to turn 0 again, never misaligning.
        // biome-ignore lint/suspicious/noExplicitAny: request body is untyped JSON
        const messages = Array.isArray((body as any)?.messages) ? (body as any).messages : [];
        // biome-ignore lint/suspicious/noExplicitAny: message entries are untyped JSON
        const priorTurns = messages.filter((m: any) => m?.role === 'assistant').length;
        const turn = script[priorTurns] ?? script[script.length - 1] ?? { text: '' };

        // Gate: if armed, hold this response open until the test releases it.
        // Consume the gate (one-shot) so a follow-up request streams normally.
        if (gate) {
          const pending = gate;
          gate = undefined;
          await pending.promise;
        }

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
    setTurns: (next: MockTurn[]) => {
      script = next;
    },
    reset: () => {
      script = [];
      requests.length = 0;
      // Release a still-armed gate so a leaked hold can't wedge the next test.
      if (gate) {
        gate.release();
        gate = undefined;
      }
    },
    gateNextTurn: () => {
      let release: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
      return { release };
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { type MockTurn, startMockModel } from './mock-model';

describe('mock-model SSE wire format', () => {
  test('official @anthropic-ai/sdk parses scripted text + tool_use turns', async () => {
    const turns: MockTurn[] = [
      { text: 'thinking…', toolUses: [{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }] },
      { text: 'all done' },
    ];
    const { baseUrl, stop, requests } = await startMockModel(turns);
    try {
      const client = new Anthropic({ apiKey: 'mock', baseURL: baseUrl });

      // --- Turn 1: text + tool_use, stop_reason tool_use ---
      const stream1 = client.messages.stream({
        model: 'claude-mock',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'go' }],
      });
      const msg1 = await stream1.finalMessage();

      expect(msg1.stop_reason).toBe('tool_use');
      const text1 = msg1.content.find((b) => b.type === 'text');
      expect(text1 && text1.type === 'text' ? text1.text : '').toBe('thinking…');
      const toolUse = msg1.content.find((b) => b.type === 'tool_use');
      expect(toolUse?.type).toBe('tool_use');
      if (toolUse?.type === 'tool_use') {
        expect(toolUse.id).toBe('tu_1');
        expect(toolUse.name).toBe('bash');
        expect(toolUse.input).toEqual({ command: 'ls' });
      }

      // --- Turn 2: text only, stop_reason end_turn ---
      const stream2 = client.messages.stream({
        model: 'claude-mock',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'continue' }],
      });
      const msg2 = await stream2.finalMessage();
      expect(msg2.stop_reason).toBe('end_turn');
      const text2 = msg2.content.find((b) => b.type === 'text');
      expect(text2 && text2.type === 'text' ? text2.text : '').toBe('all done');

      // Both requests were recorded in order.
      expect(requests.length).toBe(2);
      expect(requests[0].messages[0].content).toBe('go');
      expect(requests[1].messages[0].content).toBe('continue');
    } finally {
      await stop();
    }
  });
});

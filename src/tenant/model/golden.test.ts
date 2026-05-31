import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, CallModel } from './gateway';
import { type GoldenRecord, withGolden } from './golden';

let tmp: string;
const originalCi = process.env.CI;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'agenta-golden-'));
  // Default: not in CI. Each test that wants CI semantics sets it explicitly.
  delete process.env.CI;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalCi === undefined) delete process.env.CI;
  else process.env.CI = originalCi;
});

function rec(text: string): GoldenRecord {
  return {
    request: { messages: [{ role: 'user', content: 'irrelevant' }] },
    response: { role: 'assistant', content: text },
  };
}

function writeJsonl(path: string, records: GoldenRecord[]): void {
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function neverCallInner(_msg?: string): CallModel {
  return async () => {
    throw new Error(`inner should not be called${_msg ? `: ${_msg}` : ''}`);
  };
}

describe('withGolden — replay mode (file present)', () => {
  it('returns recorded responses positionally', async () => {
    const path = join(tmp, 'replay.jsonl');
    writeJsonl(path, [rec('first'), rec('second'), rec('third')]);

    const { callModel, flush } = withGolden(neverCallInner('replay'), path);
    const r1 = await callModel([{ role: 'user', content: 'anything 1' }]);
    const r2 = await callModel([{ role: 'user', content: 'anything 2' }]);
    const r3 = await callModel([{ role: 'user', content: 'anything 3' }]);

    expect(r1).toEqual({ role: 'assistant', content: 'first' });
    expect(r2).toEqual({ role: 'assistant', content: 'second' });
    expect(r3).toEqual({ role: 'assistant', content: 'third' });
    await flush(); // all consumed; should not throw
  });

  it('ignores request body changes — replay is positional only', async () => {
    const path = join(tmp, 'positional.jsonl');
    writeJsonl(path, [rec('one')]);

    const { callModel } = withGolden(neverCallInner('positional'), path);
    // Send a wildly different request body than was recorded — should still work.
    const out = await callModel([
      { role: 'system', content: 'totally different' },
      { role: 'user', content: 'nothing like the recording' },
    ]);
    expect(out.content).toBe('one');
  });

  it('throws when call count exceeds recording length', async () => {
    const path = join(tmp, 'overflow.jsonl');
    writeJsonl(path, [rec('only')]);
    const { callModel } = withGolden(neverCallInner('overflow'), path);
    await callModel([{ role: 'user', content: 'x' }]);
    await expect(callModel([{ role: 'user', content: 'y' }])).rejects.toThrow(/exceeds recorded/);
  });

  it('flush throws when fewer calls were made than recorded', async () => {
    const path = join(tmp, 'underflow.jsonl');
    writeJsonl(path, [rec('a'), rec('b')]);
    const { callModel, flush } = withGolden(neverCallInner('underflow'), path);
    await callModel([{ role: 'user', content: 'x' }]);
    await expect(flush()).rejects.toThrow(/only 1 of 2 recorded calls were consumed/);
  });

  it('replay path never calls inner (regression: no real model in CI)', async () => {
    const path = join(tmp, 'belt.jsonl');
    writeJsonl(path, [rec('mocked')]);
    let innerCalls = 0;
    const inner: CallModel = async () => {
      innerCalls++;
      return { role: 'assistant', content: 'REAL' };
    };
    const { callModel, flush } = withGolden(inner, path);
    const out = await callModel([{ role: 'user', content: 'x' }]);
    expect(out.content).toBe('mocked');
    expect(innerCalls).toBe(0);
    await flush();
    expect(innerCalls).toBe(0);
  });

  it('rejects a malformed JSONL line with a helpful message', () => {
    const path = join(tmp, 'bad.jsonl');
    writeFileSync(path, '{"request":{"messages":[]},"response":{"role":"assistant"}\nnot json\n');
    expect(() => withGolden(neverCallInner(), path)).toThrow(/not valid JSON/);
  });
});

describe('withGolden — record mode (file missing, not CI)', () => {
  it('forwards each call to inner, buffers, and flush writes the JSONL', async () => {
    const path = join(tmp, 'sub', 'record.jsonl');
    let innerCalls = 0;
    const inner: CallModel = async (messages) => {
      innerCalls++;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const text = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '?';
      return { role: 'assistant', content: `echo:${text}` } satisfies AssistantMessage;
    };

    const { callModel, flush } = withGolden(inner, path);
    const out1 = await callModel([{ role: 'user', content: 'first' }]);
    const out2 = await callModel([{ role: 'user', content: 'second' }], {
      tools: [
        {
          type: 'function',
          function: { name: 'noop', description: 'noop', parameters: {} },
        },
      ],
    });
    expect(out1.content).toBe('echo:first');
    expect(out2.content).toBe('echo:second');
    expect(innerCalls).toBe(2);

    await flush();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    const r1 = JSON.parse(lines[0] as string) as GoldenRecord;
    const r2 = JSON.parse(lines[1] as string) as GoldenRecord;
    expect(r1.request.messages).toEqual([{ role: 'user', content: 'first' }]);
    expect(r1.request.tools).toBeUndefined();
    expect(r1.response).toEqual({ role: 'assistant', content: 'echo:first' });
    expect(r2.request.tools?.[0]?.function.name).toBe('noop');
    expect(r2.response.content).toBe('echo:second');
  });

  it('flush is a no-op when no calls happened (does not create file)', async () => {
    const path = join(tmp, 'empty.jsonl');
    const { flush } = withGolden(neverCallInner('empty record'), path);
    await flush();
    // Read should fail — file shouldn't exist.
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });

  it('subsequent run after flush replays (round-trip)', async () => {
    const path = join(tmp, 'roundtrip.jsonl');
    const inner: CallModel = async () => ({ role: 'assistant', content: 'recorded' });
    const rec1 = withGolden(inner, path);
    await rec1.callModel([{ role: 'user', content: 'a' }]);
    await rec1.flush();

    // Now the file exists -> replay mode -> inner never invoked.
    const rec2 = withGolden(neverCallInner('after roundtrip'), path);
    const out = await rec2.callModel([{ role: 'user', content: 'a' }]);
    expect(out.content).toBe('recorded');
    await rec2.flush();
  });
});

describe('withGolden — CI guard', () => {
  it('throws on construction when file missing + CI=true', () => {
    process.env.CI = 'true';
    const path = join(tmp, 'absent.jsonl');
    expect(() => withGolden(neverCallInner('CI'), path)).toThrow(/golden file missing in CI/);
  });

  it('CI=false (literal) is treated as not-CI', () => {
    process.env.CI = 'false';
    const path = join(tmp, 'absent2.jsonl');
    // Should NOT throw — we're in record mode.
    const handle = withGolden(neverCallInner(), path);
    expect(typeof handle.callModel).toBe('function');
  });

  it('present file in CI replays normally', async () => {
    process.env.CI = '1';
    const path = join(tmp, 'present-ci.jsonl');
    writeJsonl(path, [rec('ci-ok')]);
    const { callModel } = withGolden(neverCallInner('ci replay'), path);
    const out = await callModel([{ role: 'user', content: 'x' }]);
    expect(out.content).toBe('ci-ok');
  });
});

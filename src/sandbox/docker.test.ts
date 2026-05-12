import { describe, expect, test } from 'bun:test';
import { consumeExecStream, containerName } from './docker';

describe('containerName', () => {
  test('prefixes threadKey with agenta-', () => {
    expect(containerName('c0b307lp274__1778528349_050239')).toBe(
      'agenta-c0b307lp274__1778528349_050239',
    );
  });

  test('different threadKeys produce different names', () => {
    expect(containerName('a')).not.toBe(containerName('b'));
  });
});

// Build a ReadableStream<Uint8Array> from a list of string chunks (each chunk
// arrives as a separate `enqueue`, so the parser is exercised at chunk
// boundaries that may split events).
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe('consumeExecStream', () => {
  test('parses stdout/stderr/exit events into a DockerResult', async () => {
    const r = await consumeExecStream(
      streamOf([
        'data: {"kind":"stdout","chunk":"hello "}\n\n',
        'data: {"kind":"stdout","chunk":"world"}\n\n',
        'data: {"kind":"stderr","chunk":"warn"}\n\n',
        'data: {"kind":"exit","exitCode":0}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'hello world', stderr: 'warn', exitCode: 0 });
  });

  test('joins frames split across chunks', async () => {
    const r = await consumeExecStream(
      streamOf([
        'data: {"kind":"stdout","chu',
        'nk":"hello"}\n',
        '\ndata: {"kind":"exit","exitCode":7}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'hello', stderr: '', exitCode: 7 });
  });

  test('returns exit -1 when stream ends without an exit event', async () => {
    const r = await consumeExecStream(streamOf(['data: {"kind":"stdout","chunk":"x"}\n\n']));
    expect(r.exitCode).toBe(-1);
    expect(r.stdout).toBe('x');
  });

  test('ignores non-data lines and malformed JSON', async () => {
    const r = await consumeExecStream(
      streamOf([
        ': comment\n\n',
        'data: not-json\n\n',
        'data: {"kind":"stdout","chunk":"ok"}\n\n',
        'data: {"kind":"exit","exitCode":0}\n\n',
      ]),
    );
    expect(r).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
  });
});

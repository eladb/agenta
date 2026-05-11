import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  attachmentsDir,
  deleteThreadData,
  ensureThreadDir,
  messagesPath,
  readEvents,
  threadDir,
  threadExists,
} from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenta-store-'));
  process.env.AGENTA_DATA_DIR = dir;
});

afterEach(() => {
  delete process.env.AGENTA_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('paths', () => {
  it('threadDir joins data root + thread key', () => {
    expect(threadDir('C__1_2')).toBe(join(dir, 'C__1_2'));
  });
  it('messagesPath is messages.jsonl inside threadDir', () => {
    expect(messagesPath('C__1_2')).toBe(join(dir, 'C__1_2', 'messages.jsonl'));
  });
  it('attachmentsDir is attachments inside threadDir', () => {
    expect(attachmentsDir('C__1_2')).toBe(join(dir, 'C__1_2', 'attachments'));
  });
});

describe('thread lifecycle', () => {
  it('threadExists is false until ensureThreadDir', () => {
    expect(threadExists('C__1_2')).toBe(false);
    ensureThreadDir('C__1_2');
    expect(threadExists('C__1_2')).toBe(true);
  });

  it('ensureThreadDir is idempotent', () => {
    ensureThreadDir('C__1_2');
    ensureThreadDir('C__1_2');
    expect(threadExists('C__1_2')).toBe(true);
  });
});

describe('append + read', () => {
  it('writes one JSON object per line and reads back in order', async () => {
    await appendEvent('C__1_2', { event_id: 'a', n: 1 });
    await appendEvent('C__1_2', { event_id: 'b', n: 2 });
    const events = await readEvents<{ event_id: string; n: number }>('C__1_2');
    expect(events).toEqual([
      { event_id: 'a', n: 1 },
      { event_id: 'b', n: 2 },
    ]);
  });

  it('readEvents returns [] for unknown thread', async () => {
    expect(await readEvents('nonexistent')).toEqual([]);
  });

  it('appendEvent auto-creates the thread directory', async () => {
    expect(threadExists('fresh')).toBe(false);
    await appendEvent('fresh', { event_id: 'a' });
    expect(threadExists('fresh')).toBe(true);
  });
});

describe('deleteThreadData', () => {
  it('removes the entire thread directory', async () => {
    await appendEvent('C__1_2', { event_id: 'a' });
    expect(threadExists('C__1_2')).toBe(true);
    await deleteThreadData('C__1_2');
    expect(threadExists('C__1_2')).toBe(false);
  });

  it('is a no-op for unknown threads', async () => {
    await deleteThreadData('nonexistent'); // should not throw
  });
});

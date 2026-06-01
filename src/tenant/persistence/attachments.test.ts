import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteAttachmentsForSlackTs, downloadFiles } from './attachments';
import { appendEvent, attachmentsDir, threadDir } from './store';

const ORIG_FETCH = globalThis.fetch;

type FetchHandler = (url: string) => { status: number; body: string | Buffer };
function stubFetch(handler: FetchHandler) {
  globalThis.fetch = (async (url: string) => {
    const { status, body } = handler(url);
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agenta-att-'));
  process.env.AGENTA_DATA_DIR = dir;
});
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  delete process.env.AGENTA_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const PNG = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C636400010000050001D3D2A0F90000000049454E44AE426082',
  'hex',
);

describe('downloadFiles', () => {
  it('downloads, writes to disk, detects mime from bytes', async () => {
    stubFetch(() => ({ status: 200, body: PNG }));
    const refs = await downloadFiles('tk', 'xoxb-test', [
      { id: 'F1', name: 'shot.png', url_private_download: 'https://x/F1' },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.mimetype).toBe('image/png');
    expect(refs[0]?.local_path).toBe('attachments/F1-shot.png');
    const first = refs[0];
    if (!first) throw new Error('expected at least one ref');
    const onDisk = readFileSync(join(threadDir('tk'), first.local_path));
    expect(onDisk.byteLength).toBe(PNG.byteLength);
  });

  it('skips files with no private URL (no exception, no entry)', async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return { status: 200, body: '' };
    });
    const refs = await downloadFiles('tk', 'xoxb-test', [{ id: 'F1', name: 'foo.bin' }]);
    expect(refs).toEqual([]);
    expect(called).toBe(false);
  });

  it('skips files on non-2xx response (no exception, no entry)', async () => {
    stubFetch(() => ({ status: 401, body: 'unauthorized' }));
    const refs = await downloadFiles('tk', 'xoxb-test', [
      { id: 'F1', name: 'shot.png', url_private_download: 'https://x/F1' },
    ]);
    expect(refs).toEqual([]);
    expect(existsSync(join(threadDir('tk'), 'attachments/F1-shot.png'))).toBe(false);
  });

  it('does not throw when fetch itself rejects', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;
    const refs = await downloadFiles('tk', 'xoxb-test', [
      { id: 'F1', name: 'shot.png', url_private_download: 'https://x/F1' },
    ]);
    expect(refs).toEqual([]);
  });

  it('overrides Slack-reported mimetype with byte-detected mime', async () => {
    // Slack claims text/plain but bytes are PNG
    stubFetch(() => ({ status: 200, body: PNG }));
    const refs = await downloadFiles('tk', 'xoxb-test', [
      {
        id: 'F1',
        name: 'fake.txt',
        mimetype: 'text/plain',
        url_private_download: 'https://x/F1',
      },
    ]);
    expect(refs[0]?.mimetype).toBe('image/png');
  });

  it('still records text/plain when server returns HTML (e.g. missing files:read scope)', async () => {
    const html = Buffer.from('<!doctype html><html><body>sign in</body></html>');
    stubFetch(() => ({ status: 200, body: html }));
    const refs = await downloadFiles('tk', 'xoxb-test', [
      { id: 'F1', name: 'photo.png', url_private_download: 'https://x/F1' },
    ]);
    // We trust bytes, not the file name. The HTML decodes as plaintext.
    expect(refs[0]?.mimetype).toBe('text/plain');
  });

  it('returns only successful entries when a mix of files fails', async () => {
    stubFetch((url) => {
      if (url.endsWith('/F1')) return { status: 200, body: PNG };
      return { status: 404, body: 'not found' };
    });
    const refs = await downloadFiles('tk', 'xoxb-test', [
      { id: 'F1', name: 'a.png', url_private_download: 'https://x/F1' },
      { id: 'F2', name: 'b.png', url_private_download: 'https://x/F2' },
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.file_id).toBe('F1');
  });

  it('returns empty array for empty input without touching disk', async () => {
    const refs = await downloadFiles('tk', 'xoxb-test', []);
    expect(refs).toEqual([]);
    expect(existsSync(attachmentsDir('tk'))).toBe(false);
  });
});

describe('deleteAttachmentsForSlackTs', () => {
  it('removes attachment files for the matching slack_ts and leaves others alone', async () => {
    // Set up an event referencing one attachment we'll later "delete"
    mkdirSync(attachmentsDir('tk'), { recursive: true });
    const aPath = join(attachmentsDir('tk'), 'F1-a.png');
    const bPath = join(attachmentsDir('tk'), 'F2-b.png');
    writeFileSync(aPath, PNG);
    writeFileSync(bPath, PNG);

    await appendEvent('tk', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '111.111',
        text: 'with file a',
        files: [
          {
            file_id: 'F1',
            name: 'a.png',
            mimetype: 'image/png',
            local_path: 'attachments/F1-a.png',
          },
        ],
      },
    });
    await appendEvent('tk', {
      source: 'slack',
      type: 'message',
      payload: {
        slack_ts: '222.222',
        text: 'with file b',
        files: [
          {
            file_id: 'F2',
            name: 'b.png',
            mimetype: 'image/png',
            local_path: 'attachments/F2-b.png',
          },
        ],
      },
    });

    await deleteAttachmentsForSlackTs('tk', '111.111');
    expect(existsSync(aPath)).toBe(false);
    expect(existsSync(bPath)).toBe(true);
  });

  it('is a no-op when slack_ts has no matching message event', async () => {
    await deleteAttachmentsForSlackTs('tk', 'nonexistent');
    // should not throw
  });
});

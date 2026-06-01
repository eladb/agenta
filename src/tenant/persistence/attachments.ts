import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../../shared/log';
import type { AttachmentRef } from './events';
import { detectMime } from './mime';
import { attachmentsDir, readEvents, threadDir } from './store';

type SlackFile = {
  id: string;
  name?: string;
  mimetype?: string;
  url_private_download?: string;
  url_private?: string;
};

export function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 120);
}

export async function downloadFiles(
  threadKey: string,
  botToken: string,
  files: SlackFile[],
): Promise<AttachmentRef[]> {
  if (files.length === 0) return [];
  await mkdir(attachmentsDir(threadKey), { recursive: true });

  const out: AttachmentRef[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    if (!url) {
      log.warn('attachments', `file ${f.id} has no private URL; skipping`);
      continue;
    }
    const name = sanitize(f.name ?? f.id);
    const localName = `${f.id}-${name}`;
    const fullPath = join(attachmentsDir(threadKey), localName);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${botToken}` } });
      if (!res.ok) {
        log.warn('attachments', `file ${f.id} fetch ${res.status}; skipping`);
        continue;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      await writeFile(fullPath, buf);
      const mimetype = await detectMime(buf);
      out.push({
        file_id: f.id,
        name: f.name ?? f.id,
        mimetype,
        local_path: join('attachments', localName),
      });
    } catch (err) {
      log.warn('attachments', `file ${f.id} download threw`, err);
    }
  }
  return out;
}

// Delete local attachment files corresponding to a single Slack message.
// Looks up the original SlackMessageEvent by slack_ts and removes any files it referenced.
export async function deleteAttachmentsForSlackTs(
  threadKey: string,
  slackTs: string,
): Promise<void> {
  const events = await readEvents<{
    source: string;
    type: string;
    payload: { slack_ts: string; files?: AttachmentRef[] };
  }>(threadKey);
  const original = events.find(
    (e) => e.source === 'slack' && e.type === 'message' && e.payload.slack_ts === slackTs,
  );
  const files = original?.payload.files ?? [];
  for (const f of files) {
    await unlink(join(threadDir(threadKey), f.local_path)).catch(() => {});
  }
}

export type { SlackFile };

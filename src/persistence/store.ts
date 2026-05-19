import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';

export function dataRoot(): string {
  return process.env.AGENTA_DATA_DIR ?? join(process.cwd(), 'data');
}

export function threadDir(threadKey: string): string {
  return join(dataRoot(), threadKey);
}

export function messagesPath(threadKey: string): string {
  return join(threadDir(threadKey), 'messages.jsonl');
}

export function attachmentsDir(threadKey: string): string {
  return join(threadDir(threadKey), 'attachments');
}

export function threadExists(threadKey: string): boolean {
  return existsSync(threadDir(threadKey));
}

export function ensureThreadDir(threadKey: string): void {
  mkdirSync(threadDir(threadKey), { recursive: true });
}

export async function appendEvent(threadKey: string, record: object): Promise<void> {
  ensureThreadDir(threadKey);
  await appendFile(messagesPath(threadKey), `${JSON.stringify(record)}\n`);
}

export async function readEvents<T = unknown>(threadKey: string): Promise<T[]> {
  const path = messagesPath(threadKey);
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf8');
  const out: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch (err) {
      // Tolerate corrupt lines — a single bad write shouldn't poison every
      // future turn in this thread. The model context will be slightly less
      // complete; the bot stays usable. Observed 2026-05-19 on a thread
      // whose JSONL had two events concatenated without a separating
      // newline followed by hundreds of literal spaces.
      log.warn(
        'persistence',
        `[${threadKey}] skipping malformed JSONL line (${(err as Error).message}); preview: ${JSON.stringify(trimmed.slice(0, 80))}`,
      );
    }
  }
  return out;
}

export async function deleteThreadData(threadKey: string): Promise<void> {
  await rm(threadDir(threadKey), { recursive: true, force: true });
}

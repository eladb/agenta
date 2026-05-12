import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export async function deleteThreadData(threadKey: string): Promise<void> {
  await rm(threadDir(threadKey), { recursive: true, force: true });
}

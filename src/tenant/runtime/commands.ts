export type Command = 'stop' | 'delete' | 'verbose' | 'pretty' | 'task_update';

const COMMANDS: ReadonlySet<string> = new Set([
  'stop',
  'delete',
  'verbose',
  'pretty',
  'task_update',
]);

export function parseCommand(textWithoutMention: string): Command | null {
  const trimmed = textWithoutMention.trim();
  if (!trimmed.startsWith('/')) return null;
  const candidate = trimmed.slice(1);
  return COMMANDS.has(candidate) ? (candidate as Command) : null;
}

export function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}__${threadTs.replace(/\./g, '_')}`;
}

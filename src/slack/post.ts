import type { WebClient } from '@slack/web-api';

export async function postInThread(
  web: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const res = await web.chat.postMessage({ channel, thread_ts: threadTs, text });
  if (!res.ts) throw new Error('chat.postMessage returned no ts');
  return res.ts;
}

export async function editMessage(
  web: WebClient,
  channel: string,
  ts: string,
  text: string,
): Promise<void> {
  await web.chat.update({ channel, ts, text });
}

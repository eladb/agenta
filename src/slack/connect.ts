import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { log } from '../log';

export type SlackClients = {
  socket: SocketModeClient;
  web: WebClient;
  botUserId: string;
};

export async function connect(appToken: string, botToken: string): Promise<SlackClients> {
  const web = new WebClient(botToken);
  const auth = await web.auth.test();
  const botUserId = auth.user_id;
  if (!botUserId) throw new Error('auth.test did not return user_id');

  const socket = new SocketModeClient({ appToken });

  socket.on('connected', () => log.info('slack', 'socket connected'));
  socket.on('disconnected', () => log.warn('slack', 'socket disconnected'));
  socket.on('error', (err) => log.error('slack', 'socket error', err));

  await socket.start();
  return { socket, web, botUserId };
}

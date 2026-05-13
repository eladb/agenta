import { mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { log } from '../../log';
import { newEventId, nowIso, record } from '../../persistence/events';
import { detectMime } from '../../persistence/mime';
import { attachmentsDir } from '../../persistence/store';
import { readBinary } from '../../sandbox';
import { strArg } from './helpers';
import type { Tool } from './types';

const MAX_BYTES = 25 * 1024 * 1024;

function safeFilename(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 120) || 'file';
}

export const shareFile: Tool = {
  def: {
    type: 'function',
    function: {
      name: 'share_file',
      description:
        'Upload a file from the sandbox INTO the Slack thread so the user can actually see it. CALL THIS whenever the user asks you to "send me", "show me", or "share" an image, chart, PDF, archive, or any other artifact — writing a file to the sandbox alone does NOT deliver it to the user; only share_file does. Do not invent URLs like sandbox:// or file:// — the user can\'t open those. The file appears bare in the thread; whatever surrounding prose you want the user to see (caption, explanation, summary) goes in your final assistant reply, NOT here. Max 25 MB.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Path to the file inside the sandbox (relative to the workspace ~, or absolute).',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  requiresSandbox: true,
  describe: (args) => `share ${strArg(args, 'path') ?? '?'}`,
  invoke: async (args, ctx, _signal) => {
    const path = strArg(args, 'path');
    if (!path) throw new Error('share_file: missing or invalid path');
    if (!ctx.web || !ctx.channel || !ctx.threadTs) {
      throw new Error('share_file: Slack context unavailable in this run');
    }

    const data = await readBinary(ctx.threadKey, path);
    if (data.byteLength > MAX_BYTES) {
      throw new Error(`share_file: file is ${data.byteLength} bytes, max is ${MAX_BYTES} (25 MB)`);
    }
    const filename = safeFilename(basename(path));
    const mimetype = await detectMime(data);

    // Upload. files.uploadV2 returns { files: [{ id?, files?: [{ id }] }] };
    // older shapes vary, so we accept either nested layout.
    const upload = (await ctx.web.files.uploadV2({
      channel_id: ctx.channel,
      thread_ts: ctx.threadTs,
      file: data,
      filename,
    })) as { files?: Array<{ id?: string; files?: Array<{ id?: string }> }> };
    const top = upload.files?.[0];
    const fileId = top?.files?.[0]?.id ?? top?.id;
    if (!fileId) throw new Error('share_file: Slack upload returned no file id');

    // Pull permalink + the slack_ts of the share message.
    let permalink: string | undefined;
    let slackTs: string | undefined;
    try {
      const info = await ctx.web.files.info({ file: fileId });
      permalink = (info.file as { permalink?: string } | undefined)?.permalink;
      const shares = (
        info.file as { shares?: { public?: Record<string, Array<{ ts?: string }>> } } | undefined
      )?.shares?.public;
      if (shares) {
        for (const arr of Object.values(shares)) {
          const ts = arr?.[0]?.ts;
          if (typeof ts === 'string') {
            slackTs = ts;
            break;
          }
        }
      }
    } catch (err) {
      log.warn('share_file', `files.info failed: ${(err as Error).message}`);
    }

    // Persist a local copy under attachments/ so /delete cleans it up and so
    // the thread's archived state is self-contained (matches how ingested
    // user attachments are stored).
    const localPath = `attachments/${fileId}-${filename}`;
    await mkdir(attachmentsDir(ctx.threadKey), { recursive: true });
    await fsWriteFile(join(attachmentsDir(ctx.threadKey), `${fileId}-${filename}`), data);

    // Record an assistant `message` event mirroring how user-sent files are
    // ingested. buildMessages currently doesn't project the file back to the
    // model (assistant role can't carry image content in the OpenAI-compat
    // wire format), but the archived bytes + metadata are available for the
    // future. The text field summarizes for any plain-text projection.
    await record({
      event_id: newEventId(),
      thread_key: ctx.threadKey,
      source: 'assistant',
      type: 'message',
      ts: nowIso(),
      ingested_at: nowIso(),
      payload: {
        slack_ts: slackTs ?? '',
        text: `[shared ${filename}]`,
        files: [{ file_id: fileId, name: filename, mimetype, local_path: localPath }],
      },
    });

    // Intentionally NOT returning the permalink: when the model has a URL in
    // its tool_result it tends to paste it into its final reply, producing a
    // duplicate of the file message Slack already rendered inline. file_id
    // is enough for the model to reference the upload conversationally
    // ("the chart I just shared") without giving it a URL to repeat.
    void permalink;
    return `shared ${filename} (${data.byteLength} bytes, file_id=${fileId})`;
  },
};

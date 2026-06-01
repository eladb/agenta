import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssistantMessage, CallModel, CallOptions, Message } from './gateway';

// A single recorded (request, response) pair. The request captures the
// messages array + the options that affect the wire payload (currently only
// `tools`). `signal` is intentionally excluded — it's runtime state, not part
// of the request body.
export type GoldenRecord = {
  request: {
    messages: Message[];
    tools?: CallOptions['tools'];
  };
  response: AssistantMessage;
};

export type GoldenHandle = {
  callModel: CallModel;
  // Flush is a no-op in replay mode. In record mode it writes the buffered
  // records to `goldenPath` as JSONL.
  flush: () => Promise<void>;
};

// Decide mode at construction time:
//   - file present              -> replay (never calls `inner`)
//   - file missing + CI         -> throw immediately
//   - file missing + not CI     -> record (forwards to `inner`, buffers, flush writes file)
export function withGolden(inner: CallModel, goldenPath: string): GoldenHandle {
  const ci = isCI();
  if (existsSync(goldenPath)) {
    const records = readGoldenFile(goldenPath);
    return makeReplayHandle(records, goldenPath);
  }
  if (ci) {
    throw new Error(
      `golden file missing in CI: ${goldenPath} — run the test locally first to record`,
    );
  }
  return makeRecordHandle(inner, goldenPath);
}

function isCI(): boolean {
  // Truthy `CI` is the convention across GitHub Actions, GitLab, CircleCI, etc.
  // Explicit "false"/"0"/"" disables it so tests can override without unsetenv.
  const v = process.env.CI;
  if (!v) return false;
  if (v === 'false' || v === '0') return false;
  return true;
}

function readGoldenFile(path: string): GoldenRecord[] {
  const raw = readFileSync(path, 'utf8');
  const out: GoldenRecord[] = [];
  let lineNum = 0;
  for (const line of raw.split('\n')) {
    lineNum++;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as GoldenRecord);
    } catch (err) {
      throw new Error(
        `golden file ${path}:${lineNum} is not valid JSON: ${(err as Error).message}`,
      );
    }
  }
  return out;
}

function makeReplayHandle(records: GoldenRecord[], goldenPath: string): GoldenHandle {
  let idx = 0;
  const callModel: CallModel = async (_messages, _opts) => {
    if (idx >= records.length) {
      throw new Error(
        `golden replay: call ${idx + 1} exceeds recorded length (${records.length}) in ${goldenPath}. ` +
          `Re-record by deleting the file and running locally.`,
      );
    }
    const rec = records[idx];
    if (!rec) {
      throw new Error(`golden replay: record at index ${idx} is undefined in ${goldenPath}`);
    }
    idx++;
    return rec.response;
  };
  const flush = async (): Promise<void> => {
    // Catch the "test made fewer calls than recorded" case at flush time so
    // it surfaces in `afterEach`/`afterAll`. If the test asserts on this
    // count explicitly it'll fail earlier; this is the safety net.
    if (idx < records.length) {
      throw new Error(
        `golden replay: only ${idx} of ${records.length} recorded calls were consumed in ${goldenPath}. ` +
          `The test made fewer model calls than recorded — re-record if intentional.`,
      );
    }
  };
  return { callModel, flush };
}

function makeRecordHandle(inner: CallModel, goldenPath: string): GoldenHandle {
  const buffer: GoldenRecord[] = [];
  const callModel: CallModel = async (messages, opts) => {
    // Snapshot the request BEFORE awaiting the response — callers (turn.ts)
    // mutate the `messages` array between calls (push assistant + tool
    // messages), so a reference here would all serialize to the same final
    // state at flush time. JSON.parse(JSON.stringify(...)) is a cheap deep
    // clone that's safe for the wire-format shapes we care about.
    const snapshot = JSON.parse(JSON.stringify(messages)) as Message[];
    const response = await inner(messages, opts);
    const rec: GoldenRecord = {
      request: { messages: snapshot, ...(opts?.tools ? { tools: opts.tools } : {}) },
      response,
    };
    buffer.push(rec);
    return response;
  };
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) {
      // No calls happened — don't write an empty file. The next test run will
      // be in CI-strict territory still missing this file, which is correct.
      return;
    }
    await mkdir(dirname(goldenPath), { recursive: true });
    const body = `${buffer.map((r) => JSON.stringify(r)).join('\n')}\n`;
    await writeFile(goldenPath, body, 'utf8');
  };
  return { callModel, flush };
}

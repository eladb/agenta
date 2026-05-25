import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { log } from './log';

// Skill entry as projected into the system prompt. `path` is relative to the
// agent home root (i.e. relative to the workspace, /home/sandbox/, inside the
// sandbox). Extra frontmatter fields beyond `name`/`description` flow through
// verbatim (open extension).
export type SkillEntry = {
  path: string;
  name: string;
  description: string;
  [extra: string]: unknown;
};

// Universal closing guidance appended to every system prompt regardless
// of the home repo. Lives here (not in any home repo's README.md) so the
// rule is consistent across channels and doesn't drift when a home repo
// is rewritten or replaced. Keep this short and prescriptive — it's the
// last thing the model reads before its first turn.
export const UNIVERSAL_PROMPT_SUFFIX = [
  '# Asking the user',
  '',
  'When you need a decision or input from the user, prefer the `ask_user`',
  'tool over a plain-text question. It renders interactive Slack controls',
  '(buttons, single-select, multi-select, or text input) directly in the',
  'thread — one tap on mobile vs the user typing a reply.',
  '',
  '- **buttons** — 2–4 short labeled choices (Yes/No, A/B/C)',
  '- **select** — pick one from a list of 5+ options',
  '- **multi_select** — pick any subset from a list',
  '- **text** — free-form input when the answer is not enumerable',
  '',
  'Use `ask_user` whenever the answer space is bounded or enumerable. Skip',
  'it when you can just do the task; reserve it for genuine forks (which',
  'file to edit, which env to target, which approach to take).',
].join('\n');

// Compose the system prompt for a new thread from an agent home directory.
//
// `agentHomeDir` is passed by the caller — handler.ts resolves it from
// `resolveTransport(session.home).localPath` (#87). Tests inject a tmpdir
// path directly. There is no env-default any more; the per-channel home
// config is the single source of truth.
//
// `envPrefix` defaults to `process.env.SYSTEM_PROMPT` — when set, it is
// prepended (with a blank-line separator) to the README.md body. This is the
// only behavior delta from the legacy const prompt: SYSTEM_PROMPT used to
// replace, it now prepends.
//
// Layout (inside `agentHomeDir`):
//   README.md
//   skills/<slug>/SKILL.md  (YAML frontmatter parsed for the skills map)
export async function buildSystemPrompt(
  agentHomeDir: string,
  envPrefix: string | undefined = process.env.SYSTEM_PROMPT,
): Promise<string> {
  const botPath = join(agentHomeDir, 'README.md');
  let bot = '';
  try {
    bot = await readFile(botPath, 'utf8');
  } catch (err) {
    // README.md missing is unusual but not fatal — emit a warning and continue
    // with an empty body so threads still get the env prefix + skills block.
    log.warn('prompt', `README.md not readable at ${botPath}: ${(err as Error).message}`);
  }

  const skills = await loadSkills(agentHomeDir);

  const parts: string[] = [];
  if (envPrefix && envPrefix.length > 0) parts.push(envPrefix);
  if (bot.length > 0) parts.push(bot);
  if (skills.length > 0) {
    parts.push(
      [
        '# Available skills',
        '',
        'The following skills are available in this workspace. If a skill looks',
        'relevant to a request, read its SKILL.md before proceeding so its',
        'instructions are loaded into context.',
        '',
        JSON.stringify(skills, null, 2),
      ].join('\n'),
    );
  }
  parts.push(UNIVERSAL_PROMPT_SUFFIX);
  return parts.join('\n\n');
}

async function loadSkills(agentHomeDir: string): Promise<SkillEntry[]> {
  const skillsDir = join(agentHomeDir, 'skills');
  if (!existsSync(skillsDir)) return [];
  let slugs: string[];
  try {
    slugs = await readdir(skillsDir);
  } catch (err) {
    log.warn('prompt', `skills dir not readable: ${(err as Error).message}`);
    return [];
  }
  const out: SkillEntry[] = [];
  for (const slug of slugs) {
    const skillPath = join(skillsDir, slug, 'SKILL.md');
    let s: import('node:fs').Stats;
    try {
      s = await stat(skillPath);
    } catch {
      continue; // not a skill dir (no SKILL.md), skip silently
    }
    if (!s.isFile()) continue;
    const entry = await parseSkill(skillPath, slug);
    if (entry) out.push(entry);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

async function parseSkill(skillPath: string, slug: string): Promise<SkillEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf8');
  } catch (err) {
    log.warn('prompt', `[skill ${slug}] read failed: ${(err as Error).message}`);
    return undefined;
  }
  const fm = extractFrontmatter(raw);
  if (!fm) {
    log.warn('prompt', `[skill ${slug}] missing YAML frontmatter; skipping`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(fm);
  } catch (err) {
    log.warn('prompt', `[skill ${slug}] YAML parse failed: ${(err as Error).message}`);
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    log.warn('prompt', `[skill ${slug}] frontmatter is not a mapping; skipping`);
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  const description = obj.description;
  if (typeof name !== 'string' || name.length === 0) {
    log.warn('prompt', `[skill ${slug}] missing required string "name"; skipping`);
    return undefined;
  }
  if (typeof description !== 'string' || description.length === 0) {
    log.warn('prompt', `[skill ${slug}] missing required string "description"; skipping`);
    return undefined;
  }
  // Pass through any extra keys verbatim — open extension.
  const entry: SkillEntry = {
    path: `skills/${slug}/SKILL.md`,
    name,
    description,
  };
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'name' || k === 'description') continue;
    entry[k] = v;
  }
  return entry;
}

// Extract the body between the first two `---` fences. Returns undefined if
// the file doesn't open with a `---` line. Tolerates CRLF.
function extractFrontmatter(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      return lines.slice(1, i).join('\n');
    }
  }
  return undefined;
}

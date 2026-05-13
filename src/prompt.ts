import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { log } from './log';

// Skill entry as projected into the system prompt. `path` is relative to the
// botspace root (i.e. `/workspace/...` inside the sandbox). Extra frontmatter
// fields beyond `name`/`description` flow through verbatim (open extension).
export type SkillEntry = {
  path: string;
  name: string;
  description: string;
  [extra: string]: unknown;
};

function defaultBotspaceDir(): string {
  return process.env.BOTSPACE_DIR ?? join(process.cwd(), 'sandbox/botspace');
}

// Compose the system prompt for a new thread from a botspace directory.
//
// `botspaceDir` defaults to `process.env.BOTSPACE_DIR ?? <cwd>/sandbox/botspace`.
// `envPrefix` defaults to `process.env.SYSTEM_PROMPT` — when set, it is
// prepended (with a blank-line separator) to the BOT.md body. This is the
// only behavior delta from the legacy const prompt: SYSTEM_PROMPT used to
// replace, it now prepends.
//
// Layout:
//   botspace/
//     BOT.md
//     skills/<slug>/SKILL.md  (YAML frontmatter parsed for the skills map)
export async function buildSystemPrompt(
  botspaceDir: string = defaultBotspaceDir(),
  envPrefix: string | undefined = process.env.SYSTEM_PROMPT,
): Promise<string> {
  const botPath = join(botspaceDir, 'BOT.md');
  let bot = '';
  try {
    bot = await readFile(botPath, 'utf8');
  } catch (err) {
    // BOT.md missing is unusual but not fatal — emit a warning and continue
    // with an empty body so threads still get the env prefix + skills block.
    log.warn('prompt', `BOT.md not readable at ${botPath}: ${(err as Error).message}`);
  }

  const skills = await loadSkills(botspaceDir);

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
  return parts.join('\n\n');
}

async function loadSkills(botspaceDir: string): Promise<SkillEntry[]> {
  const skillsDir = join(botspaceDir, 'skills');
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

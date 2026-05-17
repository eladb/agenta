import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from './prompt';

let agentHome: string;

beforeEach(() => {
  agentHome = mkdtempSync(join(tmpdir(), 'agenta-agent-home-'));
});

afterEach(() => {
  rmSync(agentHome, { recursive: true, force: true });
});

function writeBot(text: string): void {
  writeFileSync(join(agentHome, 'README.md'), text);
}

function writeSkill(slug: string, frontmatter: string, body = ''): void {
  const dir = join(agentHome, 'skills', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
}

describe('buildSystemPrompt', () => {
  test('README.md alone (no skills dir) -> output is README.md verbatim', async () => {
    const body = 'You are a bot.\nBe nice.';
    writeBot(body);
    const out = await buildSystemPrompt(agentHome, undefined);
    expect(out).toBe(body);
  });

  test('README.md + two valid skills -> Available skills block with sorted JSON array', async () => {
    writeBot('BOT');
    // Write in reverse alphabetical order to verify path sorting.
    writeSkill('zeta', 'name: zeta\ndescription: zeta-desc');
    writeSkill('alpha', 'name: alpha\ndescription: alpha-desc');
    const out = await buildSystemPrompt(agentHome, undefined);

    expect(out.startsWith('BOT\n\n')).toBe(true);
    expect(out).toContain('# Available skills');
    expect(out).toContain('The following skills are available in this workspace. If a skill looks');

    // Extract the JSON array from the prompt.
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const parsed = JSON.parse(out.slice(start, end + 1));
    expect(parsed).toEqual([
      { path: 'skills/alpha/SKILL.md', name: 'alpha', description: 'alpha-desc' },
      { path: 'skills/zeta/SKILL.md', name: 'zeta', description: 'zeta-desc' },
    ]);
  });

  test('skill with malformed frontmatter is skipped, other skills still emitted', async () => {
    writeBot('BOT');
    // Missing required `name` key.
    writeSkill('bad', 'description: only desc here');
    writeSkill('good', 'name: good\ndescription: good-desc');
    const out = await buildSystemPrompt(agentHome, undefined);
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    const parsed = JSON.parse(out.slice(start, end + 1));
    expect(parsed).toEqual([
      { path: 'skills/good/SKILL.md', name: 'good', description: 'good-desc' },
    ]);
  });

  test('skill with extra frontmatter fields passes them through verbatim', async () => {
    writeBot('BOT');
    writeSkill('rich', 'name: rich\ndescription: r-d\nversion: 2\ntags: [a, b]');
    const out = await buildSystemPrompt(agentHome, undefined);
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    const parsed = JSON.parse(out.slice(start, end + 1));
    expect(parsed).toEqual([
      {
        path: 'skills/rich/SKILL.md',
        name: 'rich',
        description: 'r-d',
        version: 2,
        tags: ['a', 'b'],
      },
    ]);
  });

  test('SYSTEM_PROMPT env prefix is prepended with a blank line before README.md', async () => {
    writeBot('BOT body');
    const out = await buildSystemPrompt(agentHome, 'PREFIX TEXT');
    expect(out).toBe('PREFIX TEXT\n\nBOT body');
  });

  test('zero skills -> no "Available skills" section in output', async () => {
    writeBot('BOT only');
    // No skills dir at all.
    const out = await buildSystemPrompt(agentHome, undefined);
    expect(out).not.toContain('Available skills');
    expect(out).toBe('BOT only');
  });

  test('zero skills with empty skills dir present -> still omit Available skills', async () => {
    writeBot('BOT only');
    mkdirSync(join(agentHome, 'skills'), { recursive: true });
    const out = await buildSystemPrompt(agentHome, undefined);
    expect(out).not.toContain('Available skills');
    expect(out).toBe('BOT only');
  });

  test('throws when AGENT_HOME and AGENT_HOME_DIR are both unset (no default location any more)', async () => {
    const priorRepo = process.env.AGENT_HOME;
    const priorAgentHomeDir = process.env.AGENT_HOME_DIR;
    delete process.env.AGENT_HOME;
    delete process.env.AGENT_HOME_DIR;
    try {
      // Call with no positional arg so the default-resolver runs.
      await expect(buildSystemPrompt()).rejects.toThrow(/AGENT_HOME/);
    } finally {
      if (priorRepo !== undefined) process.env.AGENT_HOME = priorRepo;
      if (priorAgentHomeDir !== undefined) process.env.AGENT_HOME_DIR = priorAgentHomeDir;
    }
  });

  test('skill without frontmatter delimiters is skipped', async () => {
    writeBot('BOT');
    // No `---` opener.
    const dir = join(agentHome, 'skills', 'plain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), 'just a body, no frontmatter');
    writeSkill('ok', 'name: ok\ndescription: o');
    const out = await buildSystemPrompt(agentHome, undefined);
    const start = out.indexOf('[');
    const end = out.lastIndexOf(']');
    const parsed = JSON.parse(out.slice(start, end + 1));
    expect(parsed).toEqual([{ path: 'skills/ok/SKILL.md', name: 'ok', description: 'o' }]);
  });
});

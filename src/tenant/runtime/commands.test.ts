import { describe, expect, it } from 'bun:test';
import { parseCommand } from './commands';

describe('parseCommand', () => {
  it('parses /stop exactly', () => {
    expect(parseCommand('/stop')).toBe('stop');
  });

  it('parses /delete exactly', () => {
    expect(parseCommand('/delete')).toBe('delete');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseCommand('  /stop  ')).toBe('stop');
  });

  it('returns null when extra text follows command', () => {
    expect(parseCommand('/stop and please')).toBeNull();
  });

  it('returns null for unknown commands', () => {
    expect(parseCommand('/reset')).toBeNull();
  });

  it('is case-sensitive — uppercase is not a command', () => {
    expect(parseCommand('/STOP')).toBeNull();
  });

  it('returns null when text does not start with /', () => {
    expect(parseCommand('hello')).toBeNull();
    expect(parseCommand('hello /stop')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import { mdToMrkdwn } from './mrkdwn';

describe('mdToMrkdwn', () => {
  test('bold: ** → *', () => {
    expect(mdToMrkdwn('hello **world**')).toBe('hello *world*');
  });

  test('italic: * → _', () => {
    expect(mdToMrkdwn('hello *world*')).toBe('hello _world_');
  });

  test('bold and italic together preserve their dialects', () => {
    expect(mdToMrkdwn('*one* **two** *three*')).toBe('_one_ *two* _three_');
  });

  test('does not collapse bold into italic-of-italic', () => {
    // Naive ordering would turn **bold** into *bold* and then into _bold_.
    expect(mdToMrkdwn('**bold**')).toBe('*bold*');
  });

  test('headings → bold (all levels)', () => {
    expect(mdToMrkdwn('# Title')).toBe('*Title*');
    expect(mdToMrkdwn('## Section')).toBe('*Section*');
    expect(mdToMrkdwn('###### Sub-sub')).toBe('*Sub-sub*');
  });

  test('headings work mid-text on a line of their own', () => {
    const input = 'intro\n\n## Section\n\nbody';
    expect(mdToMrkdwn(input)).toBe('intro\n\n*Section*\n\nbody');
  });

  test('links: [text](url) → <url|text>', () => {
    expect(mdToMrkdwn('see [docs](https://example.com)')).toBe(
      'see <https://example.com|docs>',
    );
  });

  test('images left untouched (Slack does not inline them anyway)', () => {
    expect(mdToMrkdwn('![alt](https://example.com/x.png)')).toBe(
      '![alt](https://example.com/x.png)',
    );
  });

  test('fenced code blocks are preserved verbatim', () => {
    const input = 'before\n```\n**not bold** *not italic*\n```\nafter';
    expect(mdToMrkdwn(input)).toBe(input);
  });

  test('inline code is preserved verbatim', () => {
    expect(mdToMrkdwn('use `**foo**` to bold')).toBe('use `**foo**` to bold');
  });

  test('inline code inside a sentence with other markdown', () => {
    expect(mdToMrkdwn('the `**literal**` is **really** bold')).toBe(
      'the `**literal**` is *really* bold',
    );
  });

  test('strike-through is identical in both dialects', () => {
    expect(mdToMrkdwn('~struck~')).toBe('~struck~');
  });

  test('plain text passes through', () => {
    expect(mdToMrkdwn('nothing to convert here.')).toBe('nothing to convert here.');
  });

  test('the screenshot regression: bullet list with bold items', () => {
    const input = [
      'The workspace contains:',
      '',
      '- **README.md** – a short description.',
      '- **lost+found/** – an empty directory.',
      '- **skills/** – a directory holding skills, such as `python-charts`.',
    ].join('\n');
    const expected = [
      'The workspace contains:',
      '',
      '- *README.md* – a short description.',
      '- *lost+found/* – an empty directory.',
      '- *skills/* – a directory holding skills, such as `python-charts`.',
    ].join('\n');
    expect(mdToMrkdwn(input)).toBe(expected);
  });

  test('multiple bolds on the same line', () => {
    expect(mdToMrkdwn('**a** and **b** and **c**')).toBe('*a* and *b* and *c*');
  });

  test('does not touch * inside math-like expressions', () => {
    // a * b * c shouldn't be italicized into "a _ b _ c". Our regex requires
    // non-space, non-asterisk chars adjacent to the *, so this is safe.
    expect(mdToMrkdwn('a * b * c')).toBe('a * b * c');
  });
});

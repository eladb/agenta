// Convert standard GitHub-flavored markdown (what the model emits) into
// Slack mrkdwn (what Slack renders). The model is always instructed to
// output standard markdown, so this transform has a single known input
// dialect — no mode detection required.
//
// Differences Slack cares about:
//   **bold**          -> *bold*
//   *italic*          -> _italic_
//   # Heading (1..6)  -> *Heading*       (Slack has no headings)
//   [text](url)       -> <url|text>      (images preserved as-is — Slack
//                                         won't render them inline anyway,
//                                         but the URL stays clickable)
//   ~strike~          -> ~strike~        (identical in both)
//   `code` / ```      -> unchanged       (held aside during transforms)
//
// Code regions are extracted first so transforms can't corrupt them
// (e.g. `**` inside a code block must stay literal).

const PH_OPEN = '\x00CODE_';
const PH_CLOSE = '\x00';
const PH_RE = /\x00CODE_(\d+)\x00/g;

export function mdToMrkdwn(text: string): string {
  const codes: string[] = [];

  // 1. Hold code regions aside. Fenced first (greedy across lines), then
  //    inline backticks. Order matters: an inline backtick inside a fence
  //    must stay part of the fence.
  let out = text.replace(/```[\s\S]*?```/g, (m) => {
    const i = codes.length;
    codes.push(m);
    return `${PH_OPEN}${i}${PH_CLOSE}`;
  });
  out = out.replace(/`[^`\n]+`/g, (m) => {
    const i = codes.length;
    codes.push(m);
    return `${PH_OPEN}${i}${PH_CLOSE}`;
  });

  // 2. Links → Slack's <url|text>. Skip images (![alt](url)) — Slack won't
  //    inline them but a converted link would mis-render the alt text.
  out = out.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // 3. Bold + italic in one pass — must run BEFORE headings so the
  //    heading transform's output (`*Heading*`, which is already Slack
  //    bold) isn't reprocessed as italic. Alternation puts bold first
  //    so `**x**` is consumed before `*x*` matches the inner content.
  //
  //    Inner content cannot start/end with whitespace or asterisk. This
  //    matches GitHub markdown's emphasis rules and prevents 'a * b * c'
  //    from being parsed as italic around ' b '.
  const EMPHASIS = /\*\*([^\s*](?:[^\n*]*?[^\s*])?)\*\*|\*([^\s*](?:[^\n*]*?[^\s*])?)\*/g;
  out = out.replace(EMPHASIS, (_m, bold, italic) => {
    if (bold !== undefined) return `*${bold}*`;
    return `_${italic}_`;
  });

  // 4. Headings (any level) → bold. Per-line, anchored to start. Use
  //    [^\S\n] for "whitespace but not newline" so the match can't bleed
  //    into surrounding blank lines. Allow optional atx-style closing #s.
  out = out.replace(/^#{1,6}[^\S\n]+(.+?)[^\S\n]*#*[^\S\n]*$/gm, '*$1*');

  // 5. Restore code regions.
  out = out.replace(PH_RE, (_m, i) => codes[Number(i)] ?? '');

  return out;
}

// Markup -> plain text for notes. The output is plain text that goes into a markdown note and to the note
// writer, never HTML that a page renders. Two rules keep it that way:
// - tags are removed until none is left (a nested `<scr<script>ipt>` cannot rebuild a tag), script and style
//   blocks are dropped with their content, and a stray `<` that opens no tag is dropped too;
// - entities are decoded once, in a single pass, after the tags are gone, so `&amp;lt;` stays the text `&lt;`
//   (it never turns into `<`), and a `&lt;b&gt;` that a person typed stays visible as text.

/** Replaces `pattern` until the text no longer changes. */
function untilStable(s: string, pattern: RegExp, replacement: string): string {
  let prev: string;
  do { prev = s; s = s.replace(pattern, replacement); } while (s !== prev);
  return s;
}

/** Markup without tags, comments, scripts or styles. `sep` replaces each removed piece ("" or " "). */
export function stripTags(markup: string, sep = ""): string {
  let s = untilStable(markup, /<(script|style)\b[\s\S]*?<\/\1\s*>/gi, sep);
  s = untilStable(s, /<(script|style)\b[\s\S]*$/gi, sep); // an unclosed script or style block: drop to the end
  s = untilStable(s, /<!--[\s\S]*?(?:--!?>|$)/g, sep);
  s = untilStable(s, /<[^<>]*>/g, sep);
  return s.replace(/</g, "");
}

const NAMED: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** HTML/XML entities -> characters, in one pass (so a decoded `&` never starts a second entity). */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] ?? m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

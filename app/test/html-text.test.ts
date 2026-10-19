import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { decodeEntities, stripTags } from "../src/core/html-text.ts";
import { htmlToText, vttToText } from "../src/adapters/teams.ts";
import { attachmentText, textAttachment } from "../src/core/attachments.ts";

// Markup -> plain text for notes. The output is plain text (never rendered as HTML), but no tag may survive
// the stripping and an entity is decoded once only.

test("stripTags: nested and broken tags cannot rebuild a tag", () => {
  expect(stripTags("<scr<script>ipt>alert(1)</script>")).toBe("scr"); // the script block goes, a harmless fragment stays
  expect(stripTags("a<scr<script>ipt>b")).toBe("ascr"); // an unclosed script drops to the end
  expect(stripTags("<<script>script>x")).toBe(""); // an unclosed script drops to the end
  expect(stripTags("x <script")).toBe("x ");
  expect(stripTags("x <b")).toBe("x b"); // a stray < that opens no tag is dropped
  expect(stripTags("<b>bold</b> and <i>italic</i>")).toBe("bold and italic");
  for (const s of ["<scr<script>ipt>", "<<script>script>", "<scr<scr<script>ipt>ipt>", "<img src=x onerror=alert(1)//", "<!--<script>-->"]) {
    expect(stripTags(s)).not.toContain("<");
  }
});

test("stripTags: script and style blocks are dropped with their content, comments too", () => {
  expect(stripTags("a<script>alert('x')</script>b<style>p{color:red}</style>c")).toBe("abc");
  expect(stripTags("a<SCRIPT type=x>alert(1)</SCRIPT >b")).toBe("ab");
  expect(stripTags("<scr<script>x</script>ipt>alert(1)</script>ok")).toBe("ok");
  expect(stripTags("keep<script>never closed")).toBe("keep");
  expect(stripTags("a<!-- note > here -->b<!-- odd end --!>c")).toBe("abc");
  expect(stripTags("a<b>x</b>c", " ")).toBe("a x c");
});

test("decodeEntities: one pass, so &amp;lt; stays the text &lt;", () => {
  expect(decodeEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
  expect(decodeEntities("&lt;b&gt; &amp; &quot;q&quot; &#39;s&#39; &apos;a&apos; x&nbsp;y")).toBe(`<b> & "q" 's' 'a' x y`);
  expect(decodeEntities("&#65;&#x42;&#X43;")).toBe("ABC");
  expect(decodeEntities("&unknown; &#0; &#xD800; &#99999999;")).toBe("&unknown; &#0; &#xD800; &#99999999;");
  expect(decodeEntities("R&D, AT&T")).toBe("R&D, AT&T");
});

test("Teams: normal messages are unchanged", () => {
  expect(htmlToText('<p>Hi <at id="0">Mei Ling</at>,</p><p>see <a href="https://x.example/doc">the doc</a>&nbsp;&amp; reply</p><ul><li>one</li></ul>'))
    .toBe("Hi Mei Ling,\nsee the doc (https://x.example/doc) & reply\n- one");
  expect(htmlToText('<a href="https://x.example/?a=1&amp;b=2">https://x.example/?a=1&amp;b=2</a>')).toBe("https://x.example/?a=1&b=2");
});

test("Teams: tricky HTML gives plain text with no tag and no double decoding", () => {
  expect(htmlToText("<p>a<scr<script>ipt>alert(1)</script>b</p>")).toBe("ascrb");
  expect(htmlToText("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;");
  // What a person typed as text (Teams encodes it) stays visible as text, decoded once.
  expect(htmlToText("<p>use &lt;br&gt; here</p>")).toBe("use <br> here");
  expect(htmlToText("<div>x<style>.a{}</style><script>steal()</script>y</div>")).toBe("xy");
  expect(htmlToText("<p>a<!-- c --!>b</p>")).toBe("ab");
});

test("Teams transcripts: timing lines dropped, tags removed, entities decoded once", () => {
  expect(vttToText("WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000 align:start\n<v Speaker A>Price is RM 8,000 &amp; final.</v>\n\n00:00:03.000 --> 00:00:04.000\n<v Speaker A><b>Agreed</b>.</v>"))
    .toBe("Speaker A: Price is RM 8,000 & final. Agreed.");
  expect(vttToText("WEBVTT\n\n00:01.000 --> 00:02.000\n<v Speaker B>a<scr<b>ipt>b &amp;lt;</v>")).toBe("Speaker B: ab &lt;"); // <scr<b>ipt> rebuilds <script>, which the next pass removes
  // A cue whose text mentions an arrow is kept (only real timing lines are dropped).
  expect(vttToText("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Speaker C>step 1 --> step 2</v>")).toBe("Speaker C: step 1 --> step 2");
});

test("attachments: HTML text without scripts, styles or rebuilt tags", () => {
  const read = (s: string) => textAttachment("page.html", "text/html", s).text;
  expect(read("<html><head><style>p{}</style><script>x()</script></head><body><p>Hello</p><p>World &amp; co</p></body></html>")).toBe("Hello\nWorld & co");
  expect(read("<p>a<scr<script>ipt>alert(1)</script>b</p>")).toBe("ascr b");
  expect(read("<p>&amp;lt;b&amp;gt;</p>")).toBe("&lt;b&gt;");
  expect(read("plain text with a < b and &amp;")).toBe("plain text with a < b and &amp;"); // plain text passes through
});

test("attachments: Office XML text decoded once", async () => {
  const docx = zipSync({ "word/document.xml": strToU8("<w:document><w:body><w:p><w:r><w:t>Fee &amp;lt; RM 8,000 &amp; tax</w:t></w:r></w:p><w:p><w:r><w:t xml:space=\"preserve\">&lt;draft&gt;</w:t></w:r></w:p></w:body></w:document>") });
  expect((await attachmentText("q.docx", "", docx)).text).toBe("Fee &lt; RM 8,000 & tax\n<draft>");
  const xlsx = zipSync({
    "xl/sharedStrings.xml": strToU8("<sst><si><t>A &amp;amp; B</t></si><si><r><t>x</t></r><r><t>y</t></r></si></sst>"),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>'),
  });
  expect((await attachmentText("s.xlsx", "", xlsx)).text).toBe("Sheet 1:\nA &amp; B | xy");
});

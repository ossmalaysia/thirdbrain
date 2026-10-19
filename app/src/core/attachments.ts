// Attachment text for notes (option B: knowledge from documents, no files in the vault).
// PDF via unpdf; Word/PowerPoint/Excel are zip archives of XML (fflate). Images and other binaries are
// listed by name only. Pure apart from the libraries; never writes files.
import { unzipSync, strFromU8 } from "fflate";
import { extractText as pdfText, getDocumentProxy } from "unpdf";
import { findSecret } from "./secrets.ts";
import { decodeEntities, stripTags } from "./html-text.ts";

export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024, MAX_ATTACHMENT_TEXT = 20_000, MAX_TEXT_PER_ITEM = 40_000;

export interface AttachmentInfo {
  name: string; type: string; size: number;
  /** read: text included for the AI; skipped: listed only, with the reason shown in the note. */
  status: "read" | "skipped";
  reason?: string;
  text?: string;
}

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
const tidy = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// All markup below becomes plain text for notes (not HTML): core/html-text.ts removes every tag and decodes
// entities once, after the tags are gone.

/** Text runs from Office XML: paragraphs (w:p / a:p) become lines, runs (w:t / a:t) are joined. */
function officeXmlText(xml: string, run: "w:t" | "a:t", para: "w:p" | "a:p"): string {
  return decodeEntities(stripTags(xml.replace(new RegExp(`</${para}>`, "g"), "\n").replace(new RegExp(`<${run}[^>]*>([^<]*)</${run}>`, "g"), "$1\u0001"))
    .replace(/\u0001/g, ""));
}

function xlsxText(files: Record<string, Uint8Array>): string {
  const shared = [...strFromU8(files["xl/sharedStrings.xml"] ?? new Uint8Array()).matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => decodeEntities(stripTags(m[1])));
  const sheets = Object.keys(files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  return sheets.map((f, i) => `Sheet ${i + 1}:\n` + [...strFromU8(files[f]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(c => { // cells may have no attributes at all
      const value = c[2]?.match(/<v>([^<]*)<\/v>/)?.[1] ?? c[2]?.match(/<t[^>]*>([^<]*)<\/t>/)?.[1] ?? "";
      return /t="s"/.test(c[1]) ? shared[Number(value)] ?? "" : decodeEntities(value);
    }).filter(Boolean).join(" | ")).filter(Boolean).join("\n")).join("\n\n");
}

/** Visible text of HTML/XML as plain text (styles and scripts dropped); plain text passes through. */
const markupText =(s: string) => /<[a-z!/][^>]*>/i.test(s)
  ? decodeEntities(stripTags(s.replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n"), " "))
  : s;

/** Text that is already available (Claude.ai upload text, documents Claude wrote): same cleanup, secret check and cap as files. */
export function textAttachment(name: string, type: string, raw: string, size = new TextEncoder().encode(raw).byteLength): AttachmentInfo {
  const base = { name, type, size };
  const text = tidy(markupText(raw));
  if (!text) return { ...base, status: "skipped", reason: "no text" };
  if (findSecret(text)) return { ...base, status: "skipped", reason: "withheld: looks like it contains credentials" };
  return { ...base, status: "read", text: text.length > MAX_ATTACHMENT_TEXT ? `${text.slice(0, MAX_ATTACHMENT_TEXT)}\n[truncated]` : text };
}

/** Extracts readable text from one attachment. Never throws: failures become a skipped entry. */
export async function attachmentText(name: string, type: string, bytes: Uint8Array): Promise<AttachmentInfo> {
  const base = { name, type, size: bytes.byteLength };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ...base, status: "skipped", reason: "too large to read" };
  const e = ext(name);
  let text = "";
  try {
    if (e === "pdf" || type === "application/pdf") text = (await pdfText(await getDocumentProxy(bytes), { mergePages: true })).text as string;
    else if (e === "docx") text = officeXmlText(strFromU8(unzipSync(bytes, { filter: f => f.name === "word/document.xml" })["word/document.xml"]), "w:t", "w:p");
    else if (e === "pptx") {
      const files = unzipSync(bytes, { filter: f => /^ppt\/slides\/slide\d+\.xml$/.test(f.name) });
      text = Object.keys(files).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
        .map((f, i) => `Slide ${i + 1}: ${officeXmlText(strFromU8(files[f]), "a:t", "a:p")}`).join("\n");
    }
    else if (e === "xlsx") text = xlsxText(unzipSync(bytes, { filter: f => f.name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) }));
    else if (["txt", "csv", "md", "json", "log", "html", "htm", "xml", "ics"].includes(e) || type.startsWith("text/")) text = markupText(new TextDecoder().decode(bytes));
    else if (type.startsWith("image/")) return { ...base, status: "skipped", reason: "image" };
    else return { ...base, status: "skipped", reason: "file type not read" };
  } catch { return { ...base, status: "skipped", reason: "could not be read (damaged or password-protected)" }; }
  text = tidy(text);
  if (!text) return { ...base, status: "skipped", reason: e === "pdf" ? "no text layer (scanned)" : "no text" };
  // A document with a password or key in it is withheld; the email itself still gets its note.
  if (findSecret(text)) return { ...base, status: "skipped", reason: "withheld: looks like it contains credentials" };
  return { ...base, status: "read", text: text.length > MAX_ATTACHMENT_TEXT ? `${text.slice(0, MAX_ATTACHMENT_TEXT)}\n[truncated]` : text };
}

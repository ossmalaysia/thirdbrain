import { expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { attachmentText } from "../src/core/attachments.ts";
import { emailAttachments, enrichThreadAttachments } from "../src/adapters/outlook-attachments.ts";
import { buildPrompt } from "../src/core/extract.ts";
import { renderThreadNote } from "../src/core/render.ts";
import { item, knowledge } from "./fixtures.ts";

/** A minimal valid one-page PDF showing `text` (xref offsets computed, so real PDF readers accept it). */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return strToU8(out);
}
const docx = (paras: string[]) => zipSync({ "word/document.xml": strToU8(`<w:document><w:body>${paras.map(p => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`) });
const pptx = (slides: string[]) => zipSync(Object.fromEntries(slides.map((s, i) => [`ppt/slides/slide${i + 1}.xml`, strToU8(`<p:sld><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:sld>`)])));
const xlsx = () => zipSync({ "xl/sharedStrings.xml": strToU8("<sst><si><t>Item</t></si><si><t>Claude Team seat</t></si></sst>"),
  "xl/worksheets/sheet1.xml": strToU8('<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>Price</v></c></row><row><c t="s"><v>1</v></c><c><v>1089</v></c></row></sheetData></worksheet>') });

test("reads PDF, Word, PowerPoint, Excel and text attachments", async () => {
  expect((await attachmentText("quote.pdf", "application/pdf", pdf("Total RM 34,508 valid to 21 Oct"))).text).toContain("Total RM 34,508 valid to 21 Oct");
  expect((await attachmentText("Proposal.docx", "", docx(["Scope: one-day workshop", "Fee: RM 8,000"]))).text).toBe("Scope: one-day workshop\nFee: RM 8,000");
  expect((await attachmentText("deck.pptx", "", pptx(["Agenda", "Pricing"]))).text).toBe("Slide 1: Agenda\nSlide 2: Pricing");
  expect((await attachmentText("prices.xlsx", "", xlsx())).text).toBe("Sheet 1:\nItem | Price\nClaude Team seat | 1089");
  expect((await attachmentText("notes.txt", "text/plain", strToU8("Meet at 3pm"))).text).toBe("Meet at 3pm");
});

test("images, unknown types, damaged files and credential-bearing documents are listed, not read", async () => {
  expect(await attachmentText("logo.png", "image/png", new Uint8Array(10))).toMatchObject({ status: "skipped", reason: "image" });
  expect(await attachmentText("setup.exe", "application/octet-stream", new Uint8Array(10))).toMatchObject({ status: "skipped", reason: "file type not read" });
  expect(await attachmentText("broken.docx", "", new Uint8Array([1, 2, 3]))).toMatchObject({ status: "skipped" });
  const secret = await attachmentText("access.txt", "text/plain", strToU8("Admin password: Hunter2-Secret!xyz\nAKIAIOSFODNN7EXAMPLE"));
  expect(secret).toMatchObject({ status: "skipped", reason: expect.stringContaining("credentials") });
  expect(secret.text).toBeUndefined();
});

test("email attachments: inline images ignored, files read, the text never enters the queue fields", async () => {
  const fake = { get: async () => ({ value: [
      { id: "a1", name: "Quotation.pdf", contentType: "application/pdf", size: 900, isInline: false, "@odata.type": "#microsoft.graph.fileAttachment" },
      { id: "a2", name: "signature.png", contentType: "image/png", size: 10, isInline: true, "@odata.type": "#microsoft.graph.fileAttachment" },
      { id: "a3", name: "Huge.zip", contentType: "application/zip", size: 99 * 1024 * 1024, isInline: false, "@odata.type": "#microsoft.graph.fileAttachment" },
    ] }), getBytes: async (url: string) => url.includes("/a1/") ? pdf("PO 4521 for RM 34,508") : new Uint8Array() };
  const list = await emailAttachments("msg1", fake);
  expect(list.map(a => [a.name, a.status])).toEqual([["Quotation.pdf", "read"], ["Huge.zip", "skipped"]]);
  const mail = item({ hasAttachments: true });
  await enrichThreadAttachments([mail], fake);
  const prompt = buildPrompt({ id: "t", items: [mail], existingNote: null });
  expect(prompt).toContain("#### Attachment: Quotation.pdf\nPO 4521 for RM 34,508");
  expect(prompt).toContain("#### Attachment: Huge.zip (not read: too large to read)");
});

test("notes list attachments and keep earlier ones when a thread is updated", () => {
  const earlier = "---\ntitle: x\n---\n\n## People\n- A\n\n## Attachments\n- **Old quote.pdf** (12 KB): read into this note\n\n## Links\n";
  const mail = item({ attachments: [{ name: "PO.pdf", type: "application/pdf", size: 2048, status: "read", text: "x" }, { name: "photo.jpg", type: "image/jpeg", size: 5000, status: "skipped", reason: "image" }] });
  const note = renderThreadNote({ id: "t", items: [mail], existingNote: earlier }, knowledge(), { today: "2026-10-15" }) as { content: string };
  expect(note.content).toContain("## Attachments\n- **Old quote.pdf** (12 KB): read into this note\n- **PO.pdf** (2 KB): read into this note\n- **photo.jpg** (5 KB): not read, image");
});

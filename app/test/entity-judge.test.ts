import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cascadeJudge, llmJudge, pairState, typesafeJudge, verdict, type Judge } from "../src/core/entity-judge.ts";
import { loadMerges } from "../src/core/entity-merges.ts";
import { judgeDuplicates } from "../src/entities-judge.ts";
import { rebuildEntities } from "../src/entities-rebuild.ts";
import { undoMerge, automaticDecisions } from "../src/entities-view.ts";

const OWNER = { name: "Aisyah Rahman", emails: ["aisyah@example.com"], org: "Example Works" };
const company = (slug: string, name: string, notes: string[]) => `---\ntitle: ${JSON.stringify(name)}\nsource: third-brain-sync\ntype: company\nentity_keys: [${JSON.stringify(`company:${slug}`)}]\nnote_count: ${notes.length}\n---\n\n# ${name}\n\n## Notes\n${notes.map(n => `- 2026-09-01 · [[${n}|Title of ${n.split("/").pop()}]]`).join("\n")}\n`;
const chat = (title: string, client: string) => `---\ntitle: ${JSON.stringify(title)}\ncreated: 2026-09-01\nsource: chatgpt-sync\ntags: ["ai-chat"]\naliases: []\nkind: ai-conversation\nclient: ${client}\nlast_message: 2026-09-01T10:00:00Z\n---\n\n# ${title}\n\n## Summary\nText.\n\n## Links\n- [Open](https://x)\n`;

function vault() {
  const root = mkdtempSync(join(tmpdir(), "tb-judge-"));
  const put = (rel: string, c: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), c); };
  put("inbox/entities/companies/acme.md", company("acme", "Acme", ["inbox/ai/chatgpt/a", "inbox/ai/chatgpt/b"]));
  put("inbox/entities/companies/acme-media.md", company("acme-media", "Acme Media", ["inbox/ai/chatgpt/c"]));
  put("inbox/entities/companies/zeta.md", company("zeta", "Zeta", ["inbox/ai/chatgpt/d", "inbox/ai/chatgpt/e"]));
  put("inbox/entities/companies/zeta-labs.md", company("zeta-labs", "Zeta Labs", ["inbox/ai/chatgpt/f"]));
  put("inbox/entities/companies/nova.md", company("nova", "Nova", ["inbox/ai/chatgpt/g", "inbox/ai/chatgpt/h"]));
  put("inbox/entities/companies/nova-trading.md", company("nova-trading", "Nova Trading", ["inbox/ai/chatgpt/i"]));
  for (const [n, c] of [["a", "acme"], ["b", "acme"], ["c", "acme-media"], ["d", "zeta"], ["e", "zeta"], ["f", "zeta-labs"], ["g", "nova"], ["h", "nova"], ["i", "nova-trading"]])
    put(`inbox/ai/chatgpt/${n}.md`, chat(n, c));
  return { root, file: join(root, "judgements.json"), read: (rel: string) => readFileSync(join(root, rel), "utf8") };
}
const P: Record<string, number> = { "acme-media": 0.96, "zeta-labs": 0.04, "nova-trading": 0.5 };

test("judge: sure pairs merge, sure non-pairs are dismissed, the middle waits; answers are cached", async () => {
  const v = vault();
  let asked = 0;
  const judge: Judge = async e => { asked++; return { p: P[e.b.slug] ?? 0.5, by: "decision-model", model: "jev-test" }; };
  const r = await judgeDuplicates(v.root, judge, { file: v.file });
  expect(r).toMatchObject({ pairs: 3, asked: 3, merged: 1, distinct: 1, review: 1 });
  const m = loadMerges(v.root);
  expect(m.merges).toEqual([expect.objectContaining({ from: "acme-media", to: "acme", by: "model", p: 0.96, keys: ["company:acme-media"] })]);
  expect(m.distinct).toEqual([expect.objectContaining({ a: "zeta", b: "zeta-labs", by: "model", p: 0.04 })]);
  rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
  expect(existsSync(join(v.root, "inbox/entities/companies/acme-media.md"))).toBe(false);
  // Next night: only the undecided pair is left, and its answer comes from the cache.
  const again = await judgeDuplicates(v.root, judge, { file: v.file });
  expect(again).toMatchObject({ pairs: 1, asked: 0, cached: 1, review: 1 });
  expect(asked).toBe(3);
  expect(automaticDecisions(v.root).map(d => `${d.type}:${d.from}`)).toEqual(expect.arrayContaining(["merge:acme-media", "distinct:zeta-labs"]));
});

test("undo: the merged page comes back from its notes, and the pair is not suggested again", async () => {
  const v = vault();
  await judgeDuplicates(v.root, async e => ({ p: P[e.b.slug] ?? 0.5, by: "llm", model: "m" }), { file: v.file });
  rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
  expect(v.read("inbox/ai/chatgpt/c.md")).toContain("companies/acme|Acme]]");
  undoMerge(v.root, { kind: "company", from: "acme-media", to: "acme" });
  rebuildEntities(v.root, OWNER, "2026-10-18", { dryRun: false });
  expect(existsSync(join(v.root, "inbox/entities/companies/acme-media.md"))).toBe(true);
  expect(v.read("inbox/ai/chatgpt/c.md")).toContain("companies/acme-media|");
  expect(v.read("inbox/entities/companies/acme.md")).not.toContain("company:acme-media");
  expect(loadMerges(v.root).distinct.some(d => d.a === "acme" && d.b === "acme-media")).toBe(true);
});

test("judges: the decision model's probability; the LLM's JSON; the thresholds", async () => {
  const evidence = { kind: "company", shared: 1, a: { slug: "acme", name: "Acme", aliases: [], notes: 2, titles: ["Quote"] }, b: { slug: "acme-media", name: "Acme Media", aliases: [], notes: 1, titles: ["Banner"] } };
  expect(pairState(evidence)).toContain('A: "Acme"');
  const fake = (async () => Response.json({ model: "jev-1", answers: { same: { type: "noul", noul: 0.93 } }, usage: { input_tokens: 10, output_tokens: 1 } })) as any;
  expect(await typesafeJudge("k-1234567890123456", "jev-latest", fake)(evidence)).toEqual({ p: 0.93, by: "decision-model", model: "jev-1" });
  expect(await llmJudge(async () => ({ value: { probability_same: 0.07, reason: "two firms" }, model: "gpt" }))(evidence)).toEqual({ p: 0.07, by: "llm", model: "gpt" });
  await expect(llmJudge(async () => ({ value: { probability_same: 7 }, model: "gpt" }))(evidence)).rejects.toThrow("no probability");
  expect([0.95, 0.8, 0.79, 0.5, 0.1, 0.02].map(verdict)).toEqual(["merge", "merge", "review", "review", "distinct", "distinct"]);
});

test("cascade: a sure first answer stands; an unsure one goes to the LLM, which keeps the first score", async () => {
  const e = { kind: "company", shared: 0, a: { slug: "a", name: "A", aliases: [], notes: 1, titles: [] }, b: { slug: "b", name: "B", aliases: [], notes: 1, titles: [] } };
  let llmCalls = 0;
  const llm: Judge = async () => { llmCalls++; return { p: 0.97, by: "llm", model: "gpt" }; };
  expect(await cascadeJudge(async () => ({ p: 0.95, by: "decision-model", model: "jev" }), llm)(e)).toMatchObject({ p: 0.95, by: "decision-model" });
  expect(llmCalls).toBe(0);
  expect(await cascadeJudge(async () => ({ p: 0.7, by: "decision-model", model: "jev" }), llm)(e)).toEqual({ p: 0.97, by: "llm", model: "gpt", first: 0.7 });
});

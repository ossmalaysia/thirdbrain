import { expect, test } from "bun:test";
import { entityRows, groupByOrg, groupDuplicates, pageSlice } from "../portal/view.js";

const row = (name: string, notes: number, org = "", last = "2026-01-01") => ({ kind: "person", slug: name.toLowerCase(), name, detail: org, org, notes, last, aliases: [] });

test("pageSlice: pages of a size; the page number is clamped", () => {
  const items = Array.from({ length: 60 }, (_, i) => i);
  expect(pageSlice(items, 1, 25)).toMatchObject({ page: 1, pages: 3, items: items.slice(0, 25) });
  expect(pageSlice(items, 9, 25)).toMatchObject({ page: 3, items: items.slice(50) });
  expect(pageSlice([], 1, 25)).toMatchObject({ page: 1, pages: 1, items: [] });
});

test("entityRows: search names and aliases; sort by notes, newest note or name", () => {
  const items = [row("Ana", 2), { ...row("Ben", 9), aliases: ["Benny"] }, row("Cy", 5, "", "2026-05-01")];
  expect(entityRows(items, { q: "benny" }).map(r => r.name)).toEqual(["Ben"]);
  expect(entityRows(items, { sort: "notes" }).map(r => r.name)).toEqual(["Ben", "Cy", "Ana"]);
  expect(entityRows(items, { sort: "last" })[0].name).toBe("Cy");
});

test("groupByOrg: biggest organisation first, no organisation last, one heading per group", () => {
  const g = groupByOrg([row("A", 1, "Acme"), row("B", 9, "Beta"), row("C", 3), row("D", 2, "Acme")]);
  expect(g.map(r => r.name)).toEqual(["B", "A", "D", "C"]);
  expect(g.map(r => r.group)).toEqual(["Beta", "Acme", null, "No organisation"]);
});

test("groupDuplicates: one card per page that stays, heaviest first", () => {
  const keep = { kind: "company", slug: "acme-lux", name: "Acme Lux", notes: 60 }, other = { kind: "company", slug: "zeta", name: "Zeta", notes: 2 };
  const pairs = [
    { kind: "company", keep: other, merge: { slug: "zeta-co", name: "Zeta Co", notes: 1 }, reason: "r" },
    { kind: "company", keep, merge: { slug: "acme-lux-media", name: "Acme Lux Media", notes: 12 }, reason: "r1" },
    { kind: "company", keep, merge: { slug: "acme-lux-led", name: "Acme Lux Led", notes: 1 }, reason: "r2" },
  ];
  const g = groupDuplicates(pairs);
  expect(g.map(x => x.keep.slug)).toEqual(["acme-lux", "zeta"]);
  expect(g[0].candidates.map(c => c.merge.slug)).toEqual(["acme-lux-media", "acme-lux-led"]);
});

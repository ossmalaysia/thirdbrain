import type { Item, Knowledge } from "../src/types.ts";

let n = 0;
export function item(over: Partial<Item> = {}): Item {
  n++;
  return {
    id: `msg-${n}`,
    threadId: "conv-A",
    at: `2026-09-2${n % 9}T09:00:00Z`,
    from: { name: "Jane Lim", email: "jane@acme.com" },
    to: [{ name: "Aisyah Rahman", email: "aisyah@example.com" }],
    cc: [],
    subject: "Acme renewal",
    text: "Hi Aisyah, we accept the revised rate for 2027. Please send the signed SOW by 1 Oct.",
    url: "https://outlook.office365.com/owa/?ItemID=AAMkAGRi%2BabcDEF123&exvsurl=1",
    folder: "inbox",
    ...over,
  };
}

export function knowledge(over: Partial<Knowledge> = {}): Knowledge {
  return {
    keep: true,
    reason: "renewal decision",
    title: "Acme renewal: pricing agreed",
    summary: "Acme accepted the 2027 renewal at the revised rate; Aisyah owes a signed SOW by 1 Oct.",
    client: "Acme",
    tags: ["renewal"],
    decisions: [{ what: "Renew at revised rate", when: "2026-09-22", who: ["Jane Lim"] }],
    commitments: [{ owner: "Aisyah", to: "Acme", what: "Send signed SOW", due: "2026-10-01", status: "open" }],
    people: [{ name: "Jane Lim", email: "jane@acme.com", org: "Acme", role: "Procurement" }],
    events: [],
    why: "Price cut traded for a 2-year term.",
    ...over,
  };
}

/** A currently free loopback port. Fixed test ports break when Windows reserves a range (Hyper-V/WSL/Docker). */
export function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
}

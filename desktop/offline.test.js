import { describe, expect, test } from "bun:test";
const fs = require("node:fs");
const path = require("node:path");

// Runs the inline script of offline.html against a stub page, as the window would load it with ?url=.
const html = fs.readFileSync(path.join(__dirname, "offline.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function load(query) {
  const replaced = [];
  const elements = {
    url: { textContent: "" },
    retry: { disabled: false, title: "", onclick: null, addEventListener(type, fn) { if (type === "click") this.onclick = fn; } },
  };
  const location = { search: query, replace: (u) => replaced.push(u) };
  const document = { getElementById: (id) => elements[id] };
  new Function("location", "document", "URLSearchParams", "URL", script)(location, document, URLSearchParams, URL);
  const click = () => { if (elements.retry.onclick) elements.retry.onclick(); return replaced; };
  return { shown: elements.url.textContent, retry: elements.retry, click };
}

const q = (url) => "?" + new URLSearchParams({ url }).toString();

describe("offline page Retry", () => {
  test("goes back to the local portal it was given", () => {
    const page = load(q("http://127.0.0.1:58432/"));
    expect(page.shown).toBe("http://127.0.0.1:58432/");
    expect(page.click()).toEqual(["http://127.0.0.1:58432/"]);
    expect(load(q("http://localhost:58999/")).click()).toEqual(["http://localhost:58999/"]);
    expect(load(q("https://[::1]:8443/")).click()).toEqual(["https://[::1]:8443/"]);
  });
  test("without ?url= it uses the default portal", () => {
    expect(load("").click()).toEqual(["http://127.0.0.1:58432/"]);
  });
  test("drops any path or query from the address", () => {
    expect(load(q("http://127.0.0.1:58432/x?y=1#z")).click()).toEqual(["http://127.0.0.1:58432/"]);
  });
  test("never opens javascript:, data:, file: or a remote or look-alike host", () => {
    for (const bad of [
      "javascript:alert(document.domain)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/win.ini", "https://evil.example/", "http://127.0.0.1.evil.example:58432/", "http://localhost.evil.example/",
      "http://evil.example@127.0.0.1:58432/", "http://user:pw@127.0.0.1:58432/", "not a url",
    ]) {
      const page = load(q(bad));
      expect(page.retry.disabled).toBe(true);
      expect(page.click()).toEqual([]);
      expect(page.shown).toBe(bad); // shown as text only (textContent, never HTML)
    }
  });
  test("the page never writes HTML from the query", () => {
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

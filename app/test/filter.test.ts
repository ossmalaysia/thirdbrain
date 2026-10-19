import { describe, expect, test } from "bun:test";
import { classify } from "../src/core/filter.ts";
import { findSecret } from "../src/core/secrets.ts";
import { item } from "./fixtures.ts";

const opts = { muted: ["spammy.io"] };

describe("filter: keeps real mail", () => {
  test("client email", () => expect(classify(item(), opts)).toBeNull());
  test("own sent mail even with 'unsubscribe' in quoted text", () =>
    expect(classify(item({ folder: "sentitems", from: { name: "Aisyah", email: "aisyah@example.com" }, text: "Sure. (their footer said unsubscribe)" }), opts)).toBeNull());
  test("person whose address merely contains 'news'", () =>
    expect(classify(item({ from: { name: "Newson", email: "newson.tan@acme.com" } }), opts)).toBeNull());
});

describe("filter: drops noise", () => {
  test("noreply sender", () => expect(classify(item({ from: { name: "X", email: "no-reply@github.com" } }), opts)).toBe("noise:sender"));
  test("LinkedIn notifications", () => expect(classify(item({ from: { name: "LinkedIn", email: "notifications-noreply@linkedin.com" } }), opts)).toBe("noise:sender"));
  test("bulk mail with unsubscribe", () => expect(classify(item({ from: { name: "Vendor", email: "hello@vendor.com" }, text: "Big sale! Click to unsubscribe." }), opts)).toBe("noise:bulk"));
  test("calendar response", () => expect(classify(item({ subject: "Accepted: Weekly sync" }), opts)).toBe("noise:calendar"));
  test("muted domain", () => expect(classify(item({ from: { name: "S", email: "sales@spammy.io" } }), opts)).toBe("noise:muted"));
});

describe("secrets: detected", () => {
  const cases: [string, string][] = [
    ["Your verification code is 482913", "otp"],
    ["OTP: 1234 valid for 5 minutes", "otp"],
    ["The password is Hunter2024!", "password"],
    ["Card 4111 1111 1111 1111 exp 12/28", "card"],
    ["Please pay to account no: 5140 1234 5678", "bank-account"],
    ["IC 900101-14-5678", "mykad"],
    ["NRIC S1234567D", "nric"],
    ["passport no. A12345678", "passport"],
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "api-key"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key"],
  ];
  for (const [text, kind] of cases) test(kind, () => expect(findSecret(text)).toBe(kind));
  test("email with a secret is dropped before any AI sees it", () =>
    expect(classify(item({ text: "Login code: 551234" }), opts)).toBe("secret:otp"));
});

describe("secrets: no false alarms", () => {
  for (const text of [
    "Invoice total RM 12,500.00 due 2026-10-01",
    "Call me at +60 12-345 6789",
    "Order 1234567890123 shipped", // 13 digits, fails Luhn
    "We discussed the password reset feature for the app",
    "Meeting on 2026-09-22 at 10:00",
  ]) test(text, () => expect(findSecret(text)).toBeNull());
});

test("gmail: only notification services are dropped by sender; banks, bookings and newsletters go to the decision model", () => {
  const { classify } = require("../src/core/filter.ts");
  const mail = (from: string, text = "Your booking is confirmed.") => ({ source: "gmail", folder: "inbox", from: { email: from, name: "" }, subject: "Hello", text } as any);
  expect(classify(mail("notifications@github.com"), { muted: [] })).toBe("noise:sender");
  expect(classify(mail("noreply@mail.github.com"), { muted: [] })).toBe("noise:sender");
  expect(classify(mail("no-reply@airline.example"), { muted: [] })).toBeNull();
  expect(classify(mail("alerts@bank.example", "Statement ready. Unsubscribe here."), { muted: [] })).toBeNull();
  // Outlook keeps the stricter rules.
  expect(classify({ ...mail("no-reply@airline.example"), source: "email" }, { muted: [] })).toBe("noise:sender");
});

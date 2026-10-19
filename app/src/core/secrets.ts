// Secret detection. Used twice: before any AI sees text (filter) and on the
// rendered note before it is written (render). Pure, no I/O.

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const RULES: { kind: string; test: (text: string) => boolean }[] = [
  { kind: "otp", test: t => /\b(otp|verification code|security code|one[- ]time (?:code|password|pin)|passcode|login code|auth(?:entication)? code)\b[\s\S]{0,60}?\b\d{4,8}\b/i.test(t) },
  { kind: "password", test: t => /\b(pass(?:word|wd)|pwd)\s*(?:is|[:=])\s*\S{4,}/i.test(t) },
  { kind: "card", test: t => (t.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []).some(m => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhnValid(d); }) },
  { kind: "bank-account", test: t => /\b(account|acct|a\/c)\s*(?:no\.?|number|#)?\s*[:\-]?\s*\d[\d -]{7,}\d\b/i.test(t) },
  { kind: "iban", test: t => /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/.test(t) },
  { kind: "mykad", test: t => /\b\d{6}-\d{2}-\d{4}\b/.test(t) },
  { kind: "nric", test: t => /\b[STFGM]\d{7}[A-Z]\b/.test(t) },
  { kind: "passport", test: t => /\bpassport\s*(?:no\.?|number|#)?\s*[:\-]?\s*[A-Z]{1,2}\d{6,8}\b/i.test(t) },
  { kind: "api-key", test: t => /\b(sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/.test(t) },
  { kind: "private-key", test: t => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t) },
  { kind: "jwt", test: t => /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(t) },
];

/** Returns the kind of the first secret found, or null. */
export function findSecret(text: string): string | null {
  for (const r of RULES) if (r.test(text)) return r.kind;
  return null;
}

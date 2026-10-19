# Security policy

Third Brain runs on your own computer and can reach your mail, chats and notes, so security reports matter to us.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest release (0.1.x) | Yes |
| Older releases | No: update to the latest release |

## Report a vulnerability

Do not open a public issue for a security problem.

1. Use GitHub's private report: the **Security** tab of this repository → **Report a vulnerability**.
2. Tell us what you found, how to reproduce it, and what an attacker could do with it.
3. We confirm the report within 5 working days and tell you our plan. We credit you in the release notes unless you prefer not.

Please give us a reasonable time to release a fix before you publish details.

## Scope

In scope: the portal (`app/`), the sync, the remote access through the tunnel, the desktop app (`desktop/`) and the installer.
Out of scope: GBrain itself (report to its own repository), Cloudflare, Microsoft, Anthropic or OpenAI services.

## What we do

- No secrets in the repository; a test checks the code for personal names and keys.
- Dependabot checks the packages every week.
- Code scanning (CodeQL) runs on every push once the repository is public.

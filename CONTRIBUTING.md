# Contributing to Third Brain

Thank you for helping. Third Brain reads private mail and chats, so the rules below protect users first.

## Before you start

- Open an issue first for a large change, so we can agree on the approach.
- Security problems: do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Development

```
cd app
bun install
bun test --timeout 60000
```

The desktop app: `cd desktop && bun install && bun test && bun run start`.

## Rules for every change

1. **No real data.** Never commit real names, e-mail addresses, client names, tokens, keys or vault paths, also not in
   tests, fixtures, comments or docs. Use invented names and `example.com`. A test (`no-personal-strings`) checks this.
2. **Tests.** Add or update tests for the behaviour you change; all tests must pass.
3. **Small surface.** Connectors write only into `inbox/`; never read or write outside the folders they own.
4. **Privacy by default.** New sources need a clear scope setting, the secret check, and the decision-model triage.
5. **Portal UI.** Use the shared component layer at the top of `app/portal/style.css`; no one-off styles. Check light,
   dark and a 390 px phone width.
6. **Commits.** One topic per commit, with a message that says what changed and why.

## Licence

By contributing you agree that your contribution is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)).

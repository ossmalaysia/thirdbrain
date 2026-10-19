// ChatGPT sign-in owned by the portal: login session, encrypted token storage and refresh.
// Tokens live in ~/.brain-mailsync/chatgpt-auth.json (AES-256-GCM, key in secret.key beside it),
// outside the vault; they are never logged or sent to the browser (only the account email is).
import { join } from "node:path";
import { STATE_DIR } from "./state.ts";
import { loadSecret, saveSecret } from "./secret-box.ts";
import { buildAuthorizeUrl, ChatGptError, createPkce, createState, exchangeCode, LOGIN_TIMEOUT_MS, refreshTokens,
  startCallbackListener, type BackendAuth, type CallbackListener, type ChatGptTokens } from "./core/chatgpt.ts";

export const CHATGPT_AUTH_FILE = join(STATE_DIR, "chatgpt-auth.json");
interface Stored { tokens: ChatGptTokens; expired?: boolean }

export const saveStored = (value: Stored | null, file = CHATGPT_AUTH_FILE) => saveSecret(file, value);
export const loadStored = (file = CHATGPT_AUTH_FILE) => loadSecret<Stored>(file); // tampered or foreign key: signed out

export interface ChatGptStatus { signedIn: boolean; expired: boolean; email: string | null; signingIn: boolean; loginUrl: string | null; lastLogin: { ok: boolean; at: string; message?: string } | null }

/** Opens a URL in the default browser of the signed-in Windows user (the portal runs in that session). */
const openBrowser = (url: string) => { Bun.spawn(["rundll32", "url.dll,FileProtocolHandler", url], { stdout: "ignore", stderr: "ignore", windowsHide: true }); };

export function createChatGptAuth(opts: { file?: string; fetchImpl?: typeof fetch; now?: () => number; open?: (url: string) => void; listen?: typeof startCallbackListener } = {}) {
  const file = opts.file ?? CHATGPT_AUTH_FILE, fetchImpl = opts.fetchImpl ?? fetch, now = opts.now ?? Date.now;
  const open = opts.open ?? openBrowser, listen = opts.listen ?? startCallbackListener;
  let refreshing: Promise<ChatGptTokens> | null = null;
  let login: { listener: CallbackListener; url: string } | null = null, lastLogin: ChatGptStatus["lastLogin"] = null;

  /** Single-flight refresh. Refresh tokens rotate, so if another process already refreshed, use its newer tokens. */
  function refresh(failed: ChatGptTokens): Promise<ChatGptTokens> {
    refreshing ??= (async () => {
      const latest = loadStored(file)?.tokens ?? failed;
      if (latest.accessToken !== failed.accessToken && latest.expiresAt - now() > 60_000) return latest;
      try { const tokens = await refreshTokens(latest, fetchImpl); saveStored({ tokens }, file); return tokens; }
      catch (e) {
        const again = loadStored(file);
        if (again && again.tokens.refreshToken !== latest.refreshToken && !again.expired) return again.tokens;
        if (e instanceof ChatGptError && e.kind === "auth") saveStored({ tokens: latest, expired: true }, file);
        throw e;
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  const toAuth = (t: ChatGptTokens): BackendAuth => ({ accessToken: t.accessToken, accountId: t.accountId });
  return {
    signedIn: () => { const s = loadStored(file); return !!s && !s.expired; },

    /** Valid credentials for one request, refreshing 2 minutes before expiry. */
    backendAuth: async (): Promise<BackendAuth> => {
      const s = loadStored(file);
      if (!s) throw new ChatGptError("ChatGPT is not signed in. Sign in from portal Settings.", null, "auth");
      if (s.expired) throw new ChatGptError("ChatGPT sign-in expired. Sign in again from portal Settings.", null, "auth");
      return toAuth(s.tokens.expiresAt - now() < 120_000 ? await refresh(s.tokens) : s.tokens);
    },
    /** After an HTTP 401: refresh once (or adopt tokens another process refreshed). */
    refreshAfter401: async (failed: BackendAuth): Promise<BackendAuth> => {
      const s = loadStored(file);
      if (!s || s.expired) throw new ChatGptError("ChatGPT sign-in expired. Sign in again from portal Settings.", null, "auth");
      return toAuth(await refresh(s.tokens.accessToken === failed.accessToken ? s.tokens : { ...s.tokens, accessToken: failed.accessToken }));
    },

    status: (): ChatGptStatus => {
      const s = loadStored(file);
      return { signedIn: !!s && !s.expired, expired: !!s?.expired, email: s?.tokens.email ?? null, signingIn: !!login, loginUrl: login?.url ?? null, lastLogin };
    },

    /** Starts sign-in: PKCE + state, a one-shot listener on 127.0.0.1:1455, and the browser. Returns the authorize URL. */
    startLogin: (): { url: string; started: boolean } => {
      if (login) return { url: login.url, started: false };
      const pkce = createPkce(), state = createState();
      const listener = listen(state); // throws a ChatGptError if port 1455 is busy
      const url = buildAuthorizeUrl(pkce.challenge, state);
      login = { listener, url };
      const timer = setTimeout(() => listener.close(), LOGIN_TIMEOUT_MS);
      void listener.result.then(async result => {
        if ("code" in result) {
          try {
            const tokens = await exchangeCode(result.code, pkce.verifier, fetchImpl);
            saveStored({ tokens }, file);
            lastLogin = { ok: true, at: new Date(now()).toISOString() };
            listener.finish(true);
          } catch (e) {
            const message = e instanceof ChatGptError ? e.message : "ChatGPT sign-in could not be completed.";
            lastLogin = { ok: false, at: new Date(now()).toISOString(), message };
            listener.finish(false, message);
          }
        } else lastLogin = { ok: false, at: new Date(now()).toISOString(), message: result.error === "closed" ? "Sign-in timed out or was cancelled." : "Sign-in was cancelled in the browser." };
      }).finally(() => { clearTimeout(timer); listener.close(); login = null; });
      open(url);
      return { url, started: true };
    },
    cancelLogin: () => { login?.listener.close(); },
    signOut: () => { login?.listener.close(); saveStored(null, file); lastLogin = null; },
  };
}
export type ChatGptAuth = ReturnType<typeof createChatGptAuth>;

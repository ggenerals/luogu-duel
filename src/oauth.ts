const clientId = "85694b6a-9167-48dc-9e00-343d23d826ef";
const oauthBase = "https://www.cpoauth.com";
const oauthProxy = "https://oauth.gengen.qzz.io/";
const scope = "openid profile link:luogu";
const verifierKey = "luogu-duel.oauth.verifier";
const stateKey = "luogu-duel.oauth.state";
const returnKey = "luogu-duel.oauth.return";
const sessionKey = "luogu-duel.cp-session.v1";

export type CpSession = {
  luoguName: string;
  signedInAt: number;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
};

type UserInfo = {
  username?: string;
  display_name?: string;
  linked_accounts?: Array<{
    platform?: string;
    uid?: string | number;
    username?: string;
    name?: string;
  }>;
  luogu?: {
    username?: string;
    name?: string;
    uid?: string | number;
  };
};

export const startCpOAuthLogin = async () => {
  const verifier = randomString(96);
  const state = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  sessionStorage.setItem(verifierKey, verifier);
  sessionStorage.setItem(stateKey, state);
  sessionStorage.setItem(returnKey, location.pathname === "/callback" ? "/" : `${location.pathname}${location.search}${location.hash}`);

  const url = new URL("/oauth/authorize", oauthBase);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  location.href = url.toString();
};

export const completeCpOAuthLogin = async (): Promise<string | null> => {
  if (location.pathname !== "/callback") return null;
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  const state = params.get("state");
  const expectedState = sessionStorage.getItem(stateKey);
  const verifier = sessionStorage.getItem(verifierKey);
  const returnTo = sessionStorage.getItem(returnKey) || "/";

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    throw new Error("CP OAuth 回调校验失败");
  }

  if (oauthProxy) {
    const luoguName = await completeViaProxy(code, verifier);
    cleanupOAuthStorage();
    history.replaceState(null, "", returnTo);
    if (luoguName) saveCpSession(luoguName);
    return luoguName;
  }

  const tokenResponse = await fetch(new URL("/api/oauth/token", oauthBase), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: verifier
    })
  });
  if (!tokenResponse.ok) throw new Error(`CP OAuth token failed: ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as OAuthTokenResponse;

  const userResponse = await fetch(new URL("/api/oauth/userinfo", oauthBase), {
    headers: { authorization: `Bearer ${token.access_token}` }
  });
  if (!userResponse.ok) throw new Error(`CP OAuth userinfo failed: ${userResponse.status}`);
  const userInfo = (await userResponse.json()) as UserInfo;

  cleanupOAuthStorage();
  history.replaceState(null, "", returnTo);
  const luoguName = extractLuoguName(userInfo);
  if (luoguName) saveCpSession(luoguName);
  return luoguName;
};

const completeViaProxy = async (code: string, codeVerifier: string): Promise<string | null> => {
  const response = await fetch(oauthProxy, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri(),
      client_id: clientId
    })
  });
  if (!response.ok) throw new Error(`CP OAuth proxy failed: ${response.status}`);
  const data = (await response.json()) as { luoguName?: string; username?: string; userinfo?: UserInfo };
  return data.luoguName || data.username || (data.userinfo ? extractLuoguName(data.userinfo) : null);
};

export const loadCpSession = (): CpSession | null => {
  const raw = localStorage.getItem(sessionKey);
  return raw ? (JSON.parse(raw) as CpSession) : null;
};

export const saveCpSession = (luoguName: string): CpSession => {
  const session = { luoguName, signedInAt: Date.now() };
  localStorage.setItem(sessionKey, JSON.stringify(session));
  return session;
};

export const logoutCpSession = () => {
  localStorage.removeItem(sessionKey);
  cleanupOAuthStorage();
};

const cleanupOAuthStorage = () => {
  sessionStorage.removeItem(verifierKey);
  sessionStorage.removeItem(stateKey);
  sessionStorage.removeItem(returnKey);
};

const extractLuoguName = (userInfo: UserInfo): string | null => {
  const linked = userInfo.linked_accounts?.find((account) => account.platform?.toLowerCase() === "luogu");
  return linked?.username || linked?.name || userInfo.luogu?.username || userInfo.luogu?.name || userInfo.username || null;
};

const redirectUri = (): string => import.meta.env.VITE_CP_OAUTH_REDIRECT_URI || `${location.origin}/callback`;

const randomString = (length: number): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return [...values].map((value) => alphabet[value % alphabet.length]).join("");
};

const sha256Base64Url = async (value: string): Promise<string> => {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

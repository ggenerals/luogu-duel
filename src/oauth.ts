const errorKey = "luogu-duel.oauth.error";
const sessionKey = "luogu-duel.cp-session.v1";

export type CpSession = {
  luoguName: string;
  signedInAt: number;
};

export const hasPendingCpOAuthLogin = (): boolean => false;

export const startCpOAuthLogin = async (_force = false) => {
  const url = new URL("/api/auth/login", location.origin);
  url.searchParams.set("returnTo", safeReturnTo());
  location.href = url.toString();
};

export const completeCpOAuthLogin = async (): Promise<string | null> => {
  const params = new URLSearchParams(location.search);
  const authSession = params.get("auth_session");
  const authError = params.get("auth_error");
  if (authSession || authError) {
    params.delete("auth_session");
    params.delete("auth_error");
    history.replaceState(null, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
  }
  if (authSession) {
    const session = JSON.parse(authSession) as CpSession;
    localStorage.setItem(sessionKey, JSON.stringify(session));
    return session.luoguName;
  }
  if (authError) {
    localStorage.setItem(errorKey, authError);
    return null;
  }
  const session = loadCpSession();
  return session?.luoguName ?? null;
};

export const loadCpSession = (): CpSession | null => {
  const raw = localStorage.getItem(sessionKey);
  if (raw) return JSON.parse(raw) as CpSession;
  const cookieSession = getCookie("luogu_duel_cp_session");
  if (!cookieSession) return null;
  const session = JSON.parse(cookieSession) as CpSession;
  localStorage.setItem(sessionKey, JSON.stringify(session));
  return session;
};

export const consumeCpOAuthError = (): string => {
  const message = localStorage.getItem(errorKey) || getCookie("luogu_duel_oauth_error") || "";
  localStorage.removeItem(errorKey);
  clearCookieByName("luogu_duel_oauth_error");
  return message;
};

export const saveCpSession = (luoguName: string): CpSession => {
  const session = { luoguName, signedInAt: Date.now() };
  localStorage.setItem(sessionKey, JSON.stringify(session));
  document.cookie = `luogu_duel_cp_session=${encodeURIComponent(JSON.stringify(session))}; Path=/; Max-Age=${30 * 24 * 60 * 60}; SameSite=Lax; Secure`;
  return session;
};

export const logoutCpSession = () => {
  localStorage.removeItem(sessionKey);
  clearCookieByName("luogu_duel_cp_session");
  clearCookieByName("luogu_duel_oauth_error");
};

const getCookie = (name: string): string => {
  const value = document.cookie.split("; ").find((row) => row.startsWith(`${name}=`))?.split("=").slice(1).join("=") || "";
  return value ? decodeURIComponent(value) : "";
};

const clearCookieByName = (name: string) => {
  document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
};

const safeReturnTo = (): string => {
  const current = `${location.pathname}${location.search}${location.hash}`;
  return current.startsWith("/api/auth/") ? "/" : current;
};

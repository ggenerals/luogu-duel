const sessionKey = "vjudge-duel.session";

export type VJudgeSession = {
  username: string;
  avatar?: string;
  signedInAt: number;
};

export const verifyVJudgeLogin = async (username: string): Promise<VJudgeSession> => {
  const response = await fetch("/api/auth/vjudge/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username }),
    signal: AbortSignal.timeout(12_000)
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; session?: VJudgeSession };
  if (!response.ok || !payload.session) throw new Error(payload.error || "VJudge 验证失败");
  localStorage.setItem(sessionKey, JSON.stringify(payload.session));
  return payload.session;
};

export const loadVJudgeSession = (): VJudgeSession | null => {
  try {
    const raw = localStorage.getItem(sessionKey);
    if (!raw) return null;
    const session = JSON.parse(raw) as VJudgeSession;
    return session.username?.trim() ? session : null;
  } catch {
    return null;
  }
};

export const logoutVJudgeSession = () => localStorage.removeItem(sessionKey);

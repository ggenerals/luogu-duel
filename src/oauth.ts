const sessionKey = "vjudge-duel.session.v1";

export type VJudgeSession = {
  username: string;
  avatar?: string;
  signedInAt: number;
};

export const createVJudgeChallenge = (): string =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % 900_000 + 100_000);

export const verifyVJudgeLogin = async (username: string, challenge: string): Promise<VJudgeSession> => {
  const response = await fetch("/api/auth/vjudge/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, challenge }),
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

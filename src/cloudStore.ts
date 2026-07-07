import type { SignedEnvelope } from "./types";

const endpoint = "https://vd.gengen.qzz.io";
const namespace = "luogu-duel:v1";

type CloudSnapshot = {
  version: 1;
  roomId: string;
  savedAt: number;
  envelopes: SignedEnvelope[];
};

export const loadCloudSnapshot = async (roomId: string): Promise<SignedEnvelope[]> => {
  const response = await fetch(`${endpoint}/get?key=${encodeURIComponent(roomKey(roomId))}`, {
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`cloud get failed: ${response.status}`);

  const text = await response.text();
  const value = unwrapValue(text);
  if (!value) return [];

  const snapshot = JSON.parse(value) as CloudSnapshot;
  return snapshot.roomId === roomId && Array.isArray(snapshot.envelopes) ? snapshot.envelopes : [];
};

export const saveCloudSnapshot = async (roomId: string, envelopes: SignedEnvelope[]): Promise<void> => {
  const snapshot: CloudSnapshot = {
    version: 1,
    roomId,
    savedAt: Date.now(),
    envelopes: envelopes.slice(-1000)
  };

  const response = await fetch(`${endpoint}/set?key=${encodeURIComponent(roomKey(roomId))}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(snapshot),
    keepalive: true
  });
  if (!response.ok) throw new Error(`cloud set failed: ${response.status}`);
};

const roomKey = (roomId: string): string => `${namespace}:room:${roomId}`;

const unwrapValue = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      const value = (parsed as { value?: unknown }).value;
      return typeof value === "string" ? value : JSON.stringify(value);
    }
  } catch {
    return trimmed;
  }
  return trimmed;
};

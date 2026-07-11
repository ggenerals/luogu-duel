import type { SignedEnvelope } from "./types";

export type RoomListing = {
  roomId: string;
  secret: string;
  host: string;
  createdAt: number;
  problemCount: number;
  status: "lobby" | "arena" | "finished";
  startedAt?: number;
  endedAt?: number;
  winner?: "red" | "blue" | "draw";
  redPlayers?: string[];
  bluePlayers?: string[];
};

export type UserRecord = {
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
  avatar?: string;
  color?: string;
  profileHtml?: string;
  updatedAt: number;
};

export type ServerMessage =
  | { type: "hello"; envelopes: SignedEnvelope[] }
  | { type: "event"; envelope: SignedEnvelope }
  | { type: "sync"; envelopes: SignedEnvelope[] }
  | { type: "error"; message: string };

const requestTimeoutMs = 6500;

export const fetchRooms = async (): Promise<RoomListing[]> => {
  const response = await fetch("/api/rooms", {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room directory failed: ${response.status}`);
  const data = (await response.json()) as { rooms?: RoomListing[] };
  return Array.isArray(data.rooms) ? data.rooms : [];
};

export const fetchUsers = async (): Promise<UserRecord[]> => {
  const response = await fetch("/api/users", {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`users request failed: ${response.status}`);
  const data = (await response.json()) as { users?: UserRecord[] };
  return Array.isArray(data.users) ? data.users : [];
};

export const fetchUserRecord = async (name: string): Promise<UserRecord | null> => {
  const response = await fetch(`/api/users/${encodeURIComponent(name)}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`user request failed: ${response.status}`);
  const data = (await response.json()) as { user?: UserRecord };
  return data.user ?? null;
};

export const saveUserRecord = async (user: Partial<UserRecord> & { name: string }): Promise<UserRecord> => {
  const response = await fetch(`/api/users/${encodeURIComponent(user.name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(user),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`user save failed: ${response.status}`);
  const data = (await response.json()) as { user: UserRecord };
  return data.user;
};

export const fetchSnapshot = async (roomId: string, secret: string): Promise<SignedEnvelope[]> => {
  const response = await fetch(roomApiUrl(roomId, secret, "snapshot"), {
    cache: "no-store",
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room snapshot failed: ${response.status}`);
  const data = (await response.json()) as { envelopes?: SignedEnvelope[] };
  return Array.isArray(data.envelopes) ? data.envelopes : [];
};

export const publishEnvelope = async (roomId: string, secret: string, envelope: SignedEnvelope): Promise<void> => {
  const response = await fetch(roomApiUrl(roomId, secret, "event"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    signal: AbortSignal.timeout(requestTimeoutMs)
  });
  if (!response.ok) throw new Error(`room event failed: ${response.status}`);
};

export const roomWebSocketUrl = (roomId: string, secret: string): string => {
  const url = roomApiUrl(roomId, secret, "ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const roomApiUrl = (roomId: string, secret: string, action: string): URL => {
  const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/${action}`, location.origin);
  url.searchParams.set("secret", secret);
  return url;
};

import type { FeedRecord, JudgeStatus } from "./types";

type LuoguRecord = {
  id?: number | string;
  submitTime?: number;
  status?: number | string;
  problem?: { pid?: string };
  user?: { name?: string; uid?: number };
};

export type LuoguUser = {
  uid: number;
  name: string;
  avatar?: string;
  color?: string;
};

const statusMap: Record<string, JudgeStatus> = {
  "12": "OK",
  "0": "PD",
  "2": "CE",
  "3": "WA",
  "4": "RE",
  "5": "TL",
  "6": "MLE",
  "7": "OLE",
  "11": "UKE",
  AC: "OK",
  Accepted: "OK"
};

const recordsProxy = "/api/luogu/records";

export const fetchLuoguRecords = async (pid: string, users: string[], startedAt: number): Promise<FeedRecord[]> => {
  const requestUrl = new URL(recordsProxy, location.origin);
  requestUrl.searchParams.set("pid", pid);

  const response = await fetch(requestUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Luogu records request failed: ${response.status}`);

  const data = await response.json();
  const records = findRecords(data, startedAt);
  const userSet = new Set(users);

  return records
    .map((record): FeedRecord | null => {
      const luoguName = record.user?.name;
      const status = normalizeStatus(record.status);
      const recordPid = record.problem?.pid ?? pid;
      const submittedAt = normalizeTime(record.submitTime);
      if (!luoguName || !status || !userSet.has(luoguName) || recordPid !== pid) return null;
      return {
        id: crypto.randomUUID(),
        luoguName,
        pid,
        at: submittedAt,
        status,
        recordId: String(record.id ?? `${luoguName}-${pid}-${record.submitTime ?? Date.now()}`)
      };
    })
    .filter((record): record is FeedRecord => Boolean(record));
};

export const fetchLuoguUser = async (keyword: string): Promise<LuoguUser | null> => {
  const requestUrl = new URL("/api/luogu/user/search", location.origin);
  requestUrl.searchParams.set("keyword", keyword);
  const response = await fetch(requestUrl, {
    headers: { accept: "application/json" },
    cache: "force-cache"
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { users?: LuoguUser[] };
  const normalized = keyword.trim().toLowerCase();
  return data.users?.find((user) => user.name.toLowerCase() === normalized) ?? data.users?.[0] ?? null;
};

const findRecords = (value: unknown, startedAt: number): LuoguRecord[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => findRecords(item, startedAt));
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.records)) return filterStartedRecords(object.records as LuoguRecord[], startedAt);
  if (Array.isArray(object.result)) return filterStartedRecords(object.result as LuoguRecord[], startedAt);
  if (Array.isArray(object.data)) return filterStartedRecords(object.data as LuoguRecord[], startedAt);
  return Object.values(object).flatMap((item) => findRecords(item, startedAt));
};

const filterStartedRecords = (records: LuoguRecord[], startedAt: number): LuoguRecord[] =>
  records.filter((record) => normalizeTime(record.submitTime) > startedAt);

const normalizeStatus = (status: LuoguRecord["status"]): JudgeStatus | null => {
  if (status === undefined) return null;
  return statusMap[String(status)] ?? null;
};

const normalizeTime = (time: LuoguRecord["submitTime"]): number => {
  if (typeof time === "number") return time < 10_000_000_000 ? time * 1000 : time;
  return Date.now();
};

import type { FeedRecord, JudgeStatus } from "./types";

type LuoguRecord = {
  id?: number | string;
  submitTime?: number;
  status?: number | string;
  problem?: { pid?: string };
  user?: { name?: string; uid?: number };
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

export const fetchLuoguRecords = async (pid: string, users: string[]): Promise<FeedRecord[]> => {
  const url = new URL("https://www.luogu.com.cn/record/list");
  url.searchParams.set("pid", pid);
  url.searchParams.set("_contentOnly", "1");

  const response = await fetch(url, {
    credentials: "include",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Luogu records request failed: ${response.status}`);

  const data = await response.json();
  const records = findRecords(data);
  const userSet = new Set(users);

  return records
    .map((record): FeedRecord | null => {
      const luoguName = record.user?.name;
      const status = normalizeStatus(record.status);
      const recordPid = record.problem?.pid ?? pid;
      if (!luoguName || !status || !userSet.has(luoguName) || recordPid !== pid) return null;
      return {
        id: crypto.randomUUID(),
        luoguName,
        pid,
        at: normalizeTime(record.submitTime),
        status,
        recordId: String(record.id ?? `${luoguName}-${pid}-${record.submitTime ?? Date.now()}`)
      };
    })
    .filter((record): record is FeedRecord => Boolean(record));
};

const findRecords = (value: unknown): LuoguRecord[] => {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(findRecords);
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.records)) return object.records as LuoguRecord[];
  if (Array.isArray(object.result)) return object.result as LuoguRecord[];
  if (Array.isArray(object.data)) return object.data as LuoguRecord[];
  return Object.values(object).flatMap(findRecords);
};

const normalizeStatus = (status: LuoguRecord["status"]): JudgeStatus | null => {
  if (status === undefined) return null;
  return statusMap[String(status)] ?? null;
};

const normalizeTime = (time: LuoguRecord["submitTime"]): number => {
  if (typeof time === "number") return time < 10_000_000_000 ? time * 1000 : time;
  return Date.now();
};

import { inflate } from "pako";
import type { Problem } from "./types";

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type ProblemBankItem = {
  pid: string;
  title: string;
  type: string;
  difficulty: DifficultyLevel;
};

type CachedProblemBank = {
  version: 1;
  savedAt: number;
  groups: Record<string, ProblemBankItem[]>;
};

const cacheKey = "luogu-duel.problem-bank.v1";
const sourceUrl = "https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz";
const maxCacheAgeMs = 7 * 24 * 60 * 60 * 1000;

export const difficultyMeta: Array<{ value: DifficultyLevel; label: string; short: string; color: string }> = [
  { value: 1, label: "入门（红）", short: "红", color: "#e34a4a" },
  { value: 2, label: "普及-（橙）", short: "橙", color: "#f08c2e" },
  { value: 3, label: "普及（黄）", short: "黄", color: "#d7a417" },
  { value: 4, label: "普及+/提高-（绿）", short: "绿", color: "#2fa66a" },
  { value: 5, label: "提高（青）", short: "青", color: "#1597a5" },
  { value: 6, label: "提高+/省选-（蓝）", short: "蓝", color: "#3576d4" },
  { value: 7, label: "省选/NOI-（紫）", short: "紫", color: "#8b5bd6" },
  { value: 8, label: "NOI/NOI+/CTS（黑）", short: "黑", color: "#2b3038" }
];

export const pickLuoguProblems = async (
  count: number,
  seed: string,
  low: DifficultyLevel,
  high: DifficultyLevel
): Promise<Problem[]> => {
  const groups = await loadProblemBank();
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  const pool: ProblemBankItem[] = [];
  for (let level = lo; level <= hi; level += 1) pool.push(...(groups[String(level)] ?? []));
  if (pool.length === 0) throw new Error("这个难度区间暂时没有可抽取题目");

  const picked = seededSample(pool, Math.min(count, pool.length), `${seed}:${lo}:${hi}:${count}`);
  return picked.map((item, index) => ({
    pid: item.pid,
    title: item.title,
    difficulty: item.difficulty,
    score: 100 + Math.floor(index / 3) * 50
  }));
};

export const pickLuoguReplacementProblem = async (
  currentProblems: Problem[],
  targetPid: string,
  seed: string
): Promise<Problem> => {
  const groups = await loadProblemBank();
  const target = currentProblems.find((problem) => problem.pid === targetPid);
  const used = new Set(currentProblems.map((problem) => problem.pid));
  used.delete(targetPid);
  const levels = target?.difficulty ? [target.difficulty as DifficultyLevel] : difficultyMeta.map((item) => item.value);
  const pool = levels.flatMap((level) => groups[String(level)] ?? []).filter((item) => !used.has(item.pid));
  if (!pool.length) throw new Error("题库缓存中没有可替换题目");
  const [picked] = seededSample(pool, 1, `${seed}:${targetPid}:${currentProblems.length}`);
  return {
    pid: picked.pid,
    title: picked.title,
    difficulty: picked.difficulty,
    score: target?.score ?? 100
  };
};

export const cachedProblemCount = (): number => {
  const cached = readCache();
  if (!cached) return 0;
  return Object.values(cached.groups).reduce((sum, group) => sum + group.length, 0);
};

const loadProblemBank = async (): Promise<CachedProblemBank["groups"]> => {
  const cached = readCache();
  if (cached && Date.now() - cached.savedAt < maxCacheAgeMs) return cached.groups;

  const response = await fetch(sourceUrl, { cache: "force-cache" });
  if (!response.ok) throw new Error(`题库下载失败：${response.status}`);

  const inflated = inflate(new Uint8Array(await response.arrayBuffer()), { toText: true });
  const groups = parseNdjson(inflated);
  writeCache({ version: 1, savedAt: Date.now(), groups });
  return groups;
};

const parseNdjson = (text: string): CachedProblemBank["groups"] => {
  const groups: CachedProblemBank["groups"] = Object.fromEntries(difficultyMeta.map((item) => [String(item.value), []]));
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as {
        pid?: string;
        title?: string;
        name?: string;
        type?: string;
        difficulty?: number;
      };
      if (!item.pid || !item.difficulty || item.difficulty < 1 || item.difficulty > 8) continue;
      groups[String(item.difficulty)].push({
        pid: item.pid,
        title: item.title || item.name || "",
        type: item.type || "P",
        difficulty: item.difficulty as DifficultyLevel
      });
    } catch {
      // Ignore malformed upstream rows; the public file occasionally contains fields we do not need.
    }
  }
  for (const group of Object.values(groups)) group.sort((a, b) => a.pid.localeCompare(b.pid));
  return groups;
};

const readCache = (): CachedProblemBank | null => {
  try {
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return null;
    const cached = JSON.parse(raw) as CachedProblemBank;
    return cached.version === 1 && cached.groups ? cached : null;
  } catch {
    return null;
  }
};

const writeCache = (cache: CachedProblemBank) => {
  try {
    localStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch {
    // The picker still works for this session when storage quota is unavailable.
  }
};

const seededSample = <T>(items: T[], count: number, seed: string): T[] => {
  const rng = seeded(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy.slice(0, count);
};

const seeded = (seed: string): (() => number) => {
  let h = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    h ^= seed.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

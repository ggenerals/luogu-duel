import { inflate } from "pako";
import type { Problem } from "./types";

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type ProblemPlatform = "luogu" | "codeforces" | "atcoder";
export type PlatformRatios = Record<ProblemPlatform, number>;
type BankItem = { pid: string; title: string; difficulty: DifficultyLevel; platform: ProblemPlatform };
type Progress = (platform: ProblemPlatform, percent: number, status: string) => void;

const cacheAge = 30 * 24 * 60 * 60 * 1000;
const platforms: ProblemPlatform[] = ["luogu", "codeforces", "atcoder"];
const memoryBanks = new Map<ProblemPlatform, BankItem[]>();
const sources: Record<ProblemPlatform, string> = {
  luogu: "https://cdn.luogu.com.cn/problemset-open/latest.ndjson.gz",
  codeforces: "https://codeforces.com/api/problemset.problems",
  atcoder: "/api/problem-bank/atcoder"
};
const labels: Record<ProblemPlatform, string> = {
  luogu: "洛谷",
  codeforces: "Codeforces",
  atcoder: "AtCoder"
};

export const difficultyMeta: Array<{ value: DifficultyLevel; label: string; short: string; color: string }> = [
  { value: 1, label: "入门", short: "入门", color: "#FE4C61" },
  { value: 2, label: "普及-", short: "普及-", color: "#F39C11" },
  { value: 3, label: "普及", short: "普及", color: "#FFC116" },
  { value: 4, label: "普及+/提高-", short: "普及+/提高-", color: "#52C41A" },
  { value: 5, label: "提高", short: "提高", color: "#13C2C2" },
  { value: 6, label: "提高+/省选-", short: "提高+/省选-", color: "#3498DB" },
  { value: 7, label: "省选/NOI-", short: "省选/NOI-", color: "#9D3DCF" },
  { value: 8, label: "NOI/NOI+/CTS", short: "NOI/NOI+/CTS", color: "#0E1D69" }
];

export const defaultRatios: PlatformRatios = { luogu: 2, codeforces: 1, atcoder: 1 };
export const platformLabel = (platform: ProblemPlatform): string => labels[platform];

export const parseCustomProblems = (input: string): Problem[] => {
  const seen = new Set<string>();
  return input.split(/[\s,，]+/).flatMap((raw, index) => {
    const value = decodeCustomToken(raw.trim()).replace(/^https?:\/\/vjudge\.net\/problem\//i, "");
    let platform: ProblemPlatform;
    let pid: string;
    if (/^(?:洛谷|luogu|lg)-/i.test(value)) {
      platform = "luogu";
      pid = value.replace(/^(?:洛谷|luogu|lg)-/i, "");
    } else if (/^(?:codeforces|cf)-/i.test(value)) {
      platform = "codeforces";
      pid = value.replace(/^(?:codeforces|cf)-/i, "");
    } else if (/^(?:atcoder|at)-/i.test(value)) {
      platform = "atcoder";
      pid = value.replace(/^(?:atcoder|at)-/i, "");
    } else if (/^[PB]\d+$/i.test(value)) {
      platform = "luogu";
      pid = value;
    } else if (/^\d+[A-Z][A-Z0-9]*$/i.test(value)) {
      platform = "codeforces";
      pid = value;
    } else if (/^[a-z]+\d+_[a-z0-9]+$/i.test(value)) {
      platform = "atcoder";
      pid = value;
    } else {
      return [];
    }
    const key = `${platform}:${pid.toLowerCase()}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ pid, platform, title: pid, score: 100 + Math.floor(index / 3) * 50 }];
  });
};

const decodeCustomToken = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const pickProblems = async (
  count: number,
  seed: string,
  low: DifficultyLevel,
  high: DifficultyLevel,
  ratios: PlatformRatios,
  progress: Progress
): Promise<Problem[]> => {
  const requested = normalizedRatios(ratios);
  if (!platforms.some((platform) => requested[platform] > 0)) throw new Error("请至少启用一个 OJ");

  const banks = await Promise.all(platforms.map((platform) => loadBank(platform, progress)));
  const quotas = distribute(count, requested);
  const minimum = Math.min(low, high);
  const maximum = Math.max(low, high);
  const all: BankItem[] = [];

  for (let index = 0; index < platforms.length; index += 1) {
    const platform = platforms[index];
    if (requested[platform] === 0) continue;
    const bank = banks[index].filter((item) => item.difficulty >= minimum && item.difficulty <= maximum);
    all.push(...seededSample(bank, Math.min(quotas[platform], bank.length), `${seed}:${platform}`));
  }

  if (all.length < count) {
    const used = new Set(all.map((item) => `${item.platform}:${item.pid}`));
    const fallback = banks.flatMap((bank, index) => requested[platforms[index]] > 0 ? bank : [])
      .filter((item) => item.difficulty >= minimum && item.difficulty <= maximum && !used.has(`${item.platform}:${item.pid}`));
    all.push(...seededSample(fallback, count - all.length, `${seed}:fill`));
  }

  if (all.length < count) throw new Error(`所选 OJ 和难度范围内只有 ${all.length} 道可用题目`);
  return seededSample(all, count, `${seed}:order`).map((item, index) => ({ ...item, score: 100 + Math.floor(index / 3) * 50 }));
};

export const cachedProblemCount = (): number =>
  platforms.reduce((sum, platform) => sum + (memoryBanks.get(platform)?.length ?? readCache(platform)?.items.length ?? 0), 0);

const loadBank = async (platform: ProblemPlatform, progress: Progress): Promise<BankItem[]> => {
  const memory = memoryBanks.get(platform);
  if (memory) {
    progress(platform, 100, `${memory.length.toLocaleString()} 题 · 内存缓存`);
    return memory;
  }
  const cached = readCache(platform);
  if (cached && Date.now() - cached.savedAt < cacheAge) {
    memoryBanks.set(platform, cached.items);
    progress(platform, 100, `${cached.items.length.toLocaleString()} 题 · 本地缓存`);
    return cached.items;
  }

  progress(platform, 3, "正在连接");
  const response = await fetch(sources[platform], { cache: "default", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${labels[platform]} 题库下载失败 (${response.status})`);
  const raw = await readWithProgress(response, (percent) => progress(platform, percent, `正在下载 ${percent}%`));
  progress(platform, 86, "正在解压与解析");
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? inflate(raw, { toText: true }) : new TextDecoder().decode(raw);
  const items = parseBank(platform, text);
  if (!items.length) throw new Error(`${labels[platform]} 题库没有可用难度数据`);
  memoryBanks.set(platform, items);
  writeCache(platform, items);
  progress(platform, 100, `${items.length.toLocaleString()} 题 · 已就绪`);
  return items;
};

const readWithProgress = async (response: Response, update: (percent: number) => void): Promise<Uint8Array> => {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    update(total ? Math.min(82, 5 + Math.round(loaded / total * 77)) : Math.min(82, 5 + chunks.length));
  }
  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

const parseBank = (platform: ProblemPlatform, text: string): BankItem[] => {
  if (platform === "luogu") {
    return text.split("\n").flatMap((line) => {
      try {
        const problem = JSON.parse(line) as { pid?: string; title?: string; name?: string; difficulty?: number };
        return problem.pid && problem.difficulty && problem.difficulty >= 1 && problem.difficulty <= 8
          ? [{ pid: problem.pid, title: problem.title || problem.name || problem.pid, difficulty: problem.difficulty as DifficultyLevel, platform }]
          : [];
      } catch {
        return [];
      }
    });
  }

  const data = JSON.parse(text) as { result?: { problems?: Array<{ contestId?: number; index?: string; name?: string; rating?: number }> }; [key: string]: unknown };
  if (platform === "codeforces") {
    return (data.result?.problems ?? []).flatMap((problem) =>
      problem.contestId && problem.index && problem.name && typeof problem.rating === "number"
        ? [{ pid: `${problem.contestId}${problem.index}`, title: problem.name, difficulty: cfDifficulty(problem.rating), platform }]
        : []
    );
  }
  return Object.entries(data).flatMap(([pid, model]) => {
    const difficulty = (model as { difficulty?: unknown } | null)?.difficulty;
    return typeof difficulty === "number" ? [{ pid, title: pid, difficulty: atDifficulty(difficulty), platform }] : [];
  });
};

const cfDifficulty = (rating: number): DifficultyLevel => rating <= 800 ? 1 : rating <= 1200 ? 2 : rating <= 1600 ? 3 : rating <= 1900 ? 4 : rating <= 2200 ? 5 : rating <= 2500 ? 6 : rating <= 2800 ? 7 : 8;
const atDifficulty = (rating: number): DifficultyLevel => rating <= 400 ? 1 : rating <= 800 ? 2 : rating <= 1200 ? 3 : rating <= 1700 ? 4 : rating <= 2100 ? 5 : rating <= 2400 ? 6 : rating <= 2800 ? 7 : 8;
const normalizedRatios = (ratios: PlatformRatios): PlatformRatios => Object.fromEntries(platforms.map((platform) => [platform, Math.max(0, Math.floor(ratios[platform] || 0))])) as PlatformRatios;
const distribute = (count: number, ratios: PlatformRatios): PlatformRatios => {
  const total = platforms.reduce((sum, platform) => sum + ratios[platform], 0);
  const result = Object.fromEntries(platforms.map((platform) => [platform, total ? Math.floor(count * ratios[platform] / total) : 0])) as PlatformRatios;
  let remaining = count - platforms.reduce((sum, platform) => sum + result[platform], 0);
  for (const platform of [...platforms].sort((a, b) => ratios[b] - ratios[a])) {
    if (!remaining) break;
    if (ratios[platform] > 0) {
      result[platform] += 1;
      remaining -= 1;
    }
  }
  return result;
};

const cacheKey = (platform: ProblemPlatform): string => `vjudge-duel.problem-bank.${platform}.v2`;
const readCache = (platform: ProblemPlatform): { savedAt: number; items: BankItem[] } | null => {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey(platform)) || "null") as { savedAt?: number; items?: BankItem[] } | null;
    return data?.savedAt && Array.isArray(data.items) ? { savedAt: data.savedAt, items: data.items } : null;
  } catch {
    return null;
  }
};
const writeCache = (platform: ProblemPlatform, items: BankItem[]): void => {
  try {
    localStorage.setItem(cacheKey(platform), JSON.stringify({ savedAt: Date.now(), items }));
  } catch {
    // The 26 MB Luogu source may exceed a browser's storage quota; memory caching still works.
  }
};
const seededSample = <T>(items: T[], count: number, seed: string): T[] => {
  const rng = seeded(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy.slice(0, count);
};
const seeded = (seed: string) => {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

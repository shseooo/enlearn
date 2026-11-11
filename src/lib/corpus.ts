/**
 * 코퍼스 런타임: public/data/corpus/*.json을 읽어
 * "아직 안 풀어본 문장"을 난이도/출처별로 고르고,
 * 푼 기록과 classic 레인의 한국어 번역을 브라우저에 캐시한다.
 */
import type {
  CorpusEntry,
  CorpusFile,
  CorpusLane,
  Difficulty,
} from "./types";
import { entryKey } from "./corpus-tools";

const SEEN_KEY = "enlearn.seen.v1";
const KO_CACHE_KEY = "enlearn.kocache.v1";

export const CORPUS_URLS: Record<CorpusLane, string> = {
  daily: "/data/corpus/daily.json",
  classic: "/data/corpus/classics.json",
};

export const LANE_LABELS: Record<CorpusLane, string> = {
  daily: "💬 일상 회화",
  classic: "📖 동화 명문장",
};

// ---------------------------------------------------------------------------
// 코퍼스 파일 로딩 (한 번만 내려받아 메모리에 재사용)
// ---------------------------------------------------------------------------

const fileCache = new Map<CorpusLane, CorpusFile>();
const pending = new Map<CorpusLane, Promise<CorpusFile>>();

function isCorpusFile(value: unknown): value is CorpusFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { entries?: unknown; lane?: unknown };
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as CorpusEntry).en === "string" &&
      (e as CorpusEntry).en.trim().length > 0,
  );
}

/** 테스트/사전 주입용 */
export function prefillCorpus(lane: CorpusLane, file: CorpusFile): void {
  fileCache.set(lane, file);
  pending.delete(lane);
}

export function clearCorpusCache(): void {
  fileCache.clear();
  pending.clear();
}

export function getCachedCorpus(lane: CorpusLane): CorpusFile | null {
  return fileCache.get(lane) ?? null;
}

/** 코퍼스 JSON을 내려받는다. 실패하면 원인을 사람이 읽을 수 있는 문장으로 준다. */
export async function loadCorpus(lane: CorpusLane): Promise<CorpusFile> {
  const cached = fileCache.get(lane);
  if (cached) return cached;

  const inflight = pending.get(lane);
  if (inflight) return inflight;

  const task = (async () => {
    const url = CORPUS_URLS[lane];
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(`코퍼스에 연결할 수 없습니다 (${url}).`);
    }
    if (!res.ok) {
      throw new Error(
        `코퍼스 파일이 없습니다 (HTTP ${res.status} ${url}). ` +
          `터미널에서 npm run corpus 를 먼저 실행하세요.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(`코퍼스 JSON을 해석할 수 없습니다 (${url}).`);
    }
    if (!isCorpusFile(parsed)) {
      throw new Error(`코퍼스 파일 형식이 올바르지 않습니다 (${url}).`);
    }
    fileCache.set(lane, parsed);
    return parsed;
  })().finally(() => pending.delete(lane));

  pending.set(lane, task);
  return task;
}

// ---------------------------------------------------------------------------
// 푼 문장 기록 (localStorage) — 같은 문장이 계속 나오지 않게 하는 최소 로그
// ---------------------------------------------------------------------------

type SeenMap = Record<string, string>;

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as T;
  } catch {
    // 깨진 값은 무시하고 기본값
  }
  return fallback;
}

export function loadSeen(): SeenMap {
  return readJson<SeenMap>(SEEN_KEY, {});
}

export function markSeen(key: string): void {
  if (typeof window === "undefined") return;
  const seen = loadSeen();
  seen[key] = new Date().toISOString();
  window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
}

export function isSeen(key: string): boolean {
  return key in loadSeen();
}

/** lane을 주면 그 레인만, 생략하면 전체 기록을 지운다. */
export function resetSeen(lane?: CorpusLane): void {
  if (typeof window === "undefined") return;
  const seen = loadSeen();
  const kept = Object.fromEntries(
    // 레인을 주면 그 레인만 지우고, 생략하면 전체를 지운다
    lane
      ? Object.entries(seen).filter(([k]) => !k.startsWith(`${lane}:`))
      : [],
  );
  window.localStorage.setItem(SEEN_KEY, JSON.stringify(kept));
}

export function seenCount(lane?: CorpusLane): number {
  return Object.keys(loadSeen()).filter(
    (k) => !lane || k.startsWith(`${lane}:`),
  ).length;
}

/** 출처 드롭다운에 쓸 (id, title, 개수) 목록 */
export function sourcesOf(
  file: CorpusFile,
): { id: string; title: string; count: number }[] {
  const bySource = new Map<string, { id: string; title: string; count: number }>();
  for (const e of file.entries) {
    const id = e.sourceId ?? e.source;
    const cur = bySource.get(id);
    if (cur) cur.count += 1;
    else bySource.set(id, { id, title: e.source, count: 1 });
  }
  return [...bySource.values()].sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// 문장 고르기
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 같은 날짜·레인에서는 항상 같은 순서가 나오게 하는 기본 시드 */
export function dailySeed(lane: CorpusLane, date = new Date()): number {
  return hashSeed(`${lane}:${date.toISOString().slice(0, 10)}`);
}

export interface PickOptions {
  difficulty: Difficulty;
  /** 출처(sourceId)로 좁힌다. 생략하면 전체에서 고른다. */
  sourceId?: string;
  /** true면 이미 푼 문장도 후보에 포함한다. */
  includeSeen?: boolean;
  seed?: number;
}

export interface PickResult {
  entry: CorpusEntry;
  /** 이미 푼 문장을 다시 보여준 경우 true */
  recycled: boolean;
}

function matchesSource(entry: CorpusEntry, sourceId?: string): boolean {
  if (!sourceId || sourceId === "all") return true;
  return (entry.sourceId ?? entry.source) === sourceId;
}

/**
 * 후보를 고른다. 좁혀가는 순서:
 * (난이도+출처, 미풀음) → (난이도 완화, 미풀음) → (출처 전체, 미풀음) → (다시 출제)
 */
export function pickEntry(
  file: CorpusFile,
  options: PickOptions,
): PickResult | null {
  const seen = loadSeen();
  const rand = mulberry32(options.seed ?? dailySeed(file.lane));

  const pools: { list: CorpusEntry[]; recycled: boolean }[] = [
    {
      list: file.entries.filter(
        (e) =>
          e.difficulty === options.difficulty &&
          matchesSource(e, options.sourceId) &&
          (options.includeSeen || !(entryKey(e) in seen)),
      ),
      recycled: false,
    },
    {
      list: file.entries.filter((e) => matchesSource(e, options.sourceId)),
      recycled: true,
    },
  ];

  for (const pool of pools) {
    if (pool.list.length === 0) continue;
    const entry = pool.list[Math.floor(rand() * pool.list.length) % pool.list.length];
    return { entry, recycled: pool.recycled };
  }
  return null;
}

// ---------------------------------------------------------------------------
// classic 레인의 한국어 번역 캐시 (LLM 번역은 한 번만)
// ---------------------------------------------------------------------------

export interface CachedKorean {
  ko: string;
  hints: string[];
}

export function getCachedKorean(key: string): CachedKorean | null {
  const store = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  const value = store[key];
  if (!value || typeof value.ko !== "string" || !value.ko.trim()) return null;
  return { ko: value.ko, hints: Array.isArray(value.hints) ? value.hints : [] };
}

export function cacheKorean(key: string, ko: string, hints: string[]): void {
  if (typeof window === "undefined") return;
  const store = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  store[key] = { ko, hints };
  window.localStorage.setItem(KO_CACHE_KEY, JSON.stringify(store));
}

/** 화면에 쓸 한국어 문장: 코퍼스에 있으면 그대로, classic이면 캐시된 LLM 번역 */
export function resolveKorean(entry: CorpusEntry): string | null {
  if (entry.ko && entry.ko.trim()) return entry.ko.trim();
  return getCachedKorean(entryKey(entry))?.ko ?? null;
}

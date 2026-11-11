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

// v2: entryKey가 해시 기반으로 바뀌어 v1 값은 재사용할 수 없다 (기록 초기화).
const SEEN_KEY = "enlearn.seen.v2";
const KO_CACHE_KEY = "enlearn.kocache.v2";

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

const DIFFICULTIES = ["easy", "normal", "hard"];

function isCorpusEntry(value: unknown): value is CorpusEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.en !== "string" || !e.en.trim()) return false;
  if (e.ko !== null && typeof e.ko !== "string") return false;
  if (typeof e.source !== "string") return false;
  if (e.sourceId !== null && typeof e.sourceId !== "string") return false;
  if (typeof e.lane !== "string" || !LANE_LABELS[e.lane as CorpusLane])
    return false;
  if (typeof e.difficulty !== "string" || !DIFFICULTIES.includes(e.difficulty))
    return false;
  if (
    !Array.isArray(e.hints) ||
    !e.hints.every((h) => typeof h === "string" && h.trim())
  )
    return false;
  return true;
}

function isCorpusFile(value: unknown): value is CorpusFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { entries?: unknown; lane?: unknown };
  if (!Array.isArray(v.entries)) return false;
  // lane/난이도/힌트까지 검사한다: 깨진 파일을 통과시키면 난이도 필터가
  // 아무것도 매칭하지 못해 조용히 재출제 폴백으로 빠진다.
  return v.entries.every(isCorpusEntry);
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
  notifyProgress();
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
  notifyProgress();
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

/** 로력(사용자의 달력) 날짜. toISOString()은 UTC 기준이라 KST 09:00에 하루가 바뀐다. */
export function localDateString(date = new Date()): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 같은 날짜·레인에서는 항상 같은 순서가 나오게 하는 기본 시드 (로컬 자정 기준) */
export function dailySeed(lane: CorpusLane, date = new Date()): number {
  return hashSeed(`${lane}:${localDateString(date)}`);
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
 * 후보를 고른다. 우선순위(높은 순):
 *   1) 같은 난이도 + 같은 출처 + 안 푼 문장
 *   2) 같은 난이도 + 안 푼 문장   (출처 완화 — 학습 난이도를 먼저 지킨다)
 *   3) 같은 출처 + 안 푼 문장     (난이도 완화)
 *   4) 안 푼 문장 전체
 *   5) 같은 조건에서 푼 문장 포함 (재출제)
 * recycled는 "풀 단위"가 아니라 실제로 이미 푼 문장을 골랐을 때만 true다.
 */
export function pickEntry(
  file: CorpusFile,
  options: PickOptions,
): PickResult | null {
  if (file.entries.length === 0) return null;

  const seen = loadSeen();
  const rand = mulberry32(options.seed ?? dailySeed(file.lane));

  const rankOf = (e: CorpusEntry): number => {
    const unseen = options.includeSeen || !(entryKey(e) in seen);
    const sameDifficulty = e.difficulty === options.difficulty;
    const sameSource = matchesSource(e, options.sourceId);
    if (unseen) {
      if (sameDifficulty && sameSource) return 0;
      if (sameDifficulty) return 1;
      if (sameSource) return 2;
      return 3;
    }
    if (sameDifficulty && sameSource) return 4;
    if (sameDifficulty) return 5;
    if (sameSource) return 6;
    return 7;
  };

  let best = Number.POSITIVE_INFINITY;
  let candidates: CorpusEntry[] = [];
  for (const e of file.entries) {
    const rank = rankOf(e);
    if (rank < best) {
      best = rank;
      candidates = [e];
    } else if (rank === best) {
      candidates.push(e);
    }
  }
  if (candidates.length === 0) return null;

  const entry =
    candidates[Math.floor(rand() * candidates.length) % candidates.length];
  return { entry, recycled: entryKey(entry) in seen };
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
  if (
    !value ||
    typeof value.ko !== "string" ||
    !value.ko.trim() ||
    // 캐시된 힌트를 그대로 UI state에 넣으므로 문자열 배열인지 확인한다
    !Array.isArray(value.hints) ||
    !value.hints.every((h) => typeof h === "string")
  ) {
    return null;
  }
  return { ko: value.ko, hints: value.hints };
}

export function cacheKorean(key: string, ko: string, hints: string[]): void {
  if (typeof window === "undefined") return;
  const store = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  store[key] = { ko, hints };
  window.localStorage.setItem(KO_CACHE_KEY, JSON.stringify(store));
  notifyProgress();
}

/** 캐시된 한국어 번역 개수 (설정 화면 표시용) */
export function koreanCacheCount(lane?: CorpusLane): number {
  return Object.keys(
    readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {}),
  ).filter((k) => !lane || k.startsWith(`${lane}:`)).length;
}

/**
 * 한국어 번역 캐시를 지운다. lane을 주면 그 레인만, 생략하면 전체.
 * 엉터리/환각 번역이 한 번 캐시되면 다시 볼 수 없으므로 초기화 수단이 필요하다.
 */
export function clearKoreanCache(lane?: CorpusLane): void {
  if (typeof window === "undefined") return;
  const store = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  const kept = lane
    ? Object.fromEntries(
        Object.entries(store).filter(([k]) => !k.startsWith(`${lane}:`)),
      )
    : {};
  window.localStorage.setItem(KO_CACHE_KEY, JSON.stringify(kept));
  notifyProgress();
}

// ---------------------------------------------------------------------------
// 진행 상황 스냅샷 (useSyncExternalStore용) — 설정 화면에 개수를 보여준다
// ---------------------------------------------------------------------------

const PROGRESS_EVENT = "enlearn:progress-changed";

export interface ProgressCounts {
  daily: number;
  classic: number;
  korean: number;
}

const EMPTY_PROGRESS: ProgressCounts = { daily: 0, classic: 0, korean: 0 };
let progressRaw = "";
let progressValue: ProgressCounts = EMPTY_PROGRESS;

function notifyProgress(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROGRESS_EVENT));
}

export function subscribeToProgress(callback: () => void): () => void {
  window.addEventListener("storage", callback); // 다른 탭 변경
  window.addEventListener(PROGRESS_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(PROGRESS_EVENT, callback);
  };
}

/** 값이 바뀐 뒤에야 새 참조를 돌려준다 (무한 재렌더 방지) */
export function getProgressSnapshot(): ProgressCounts {
  const raw = `${window.localStorage.getItem(SEEN_KEY) ?? ""}|${
    window.localStorage.getItem(KO_CACHE_KEY) ?? ""
  }`;
  if (raw !== progressRaw) {
    progressRaw = raw;
    progressValue = {
      daily: seenCount("daily"),
      classic: seenCount("classic"),
      korean: koreanCacheCount(),
    };
  }
  return progressValue;
}

/** SSR/하이드레이션용: 항상 같은 참조를 돌려주는 0 값 */
export function getProgressServerSnapshot(): ProgressCounts {
  return EMPTY_PROGRESS;
}

/** 화면에 쓸 한국어 문장: 코퍼스에 있으면 그대로, classic이면 캐시된 LLM 번역 */
export function resolveKorean(entry: CorpusEntry): string | null {
  if (entry.ko && entry.ko.trim()) return entry.ko.trim();
  return getCachedKorean(entryKey(entry))?.ko ?? null;
}

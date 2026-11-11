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
import { parseStored, safeSetItem } from "./storage";

// v2: entryKey가 해시 기반으로 바뀌어 v1 값은 재사용할 수 없다 (기록 초기화).
const SEEN_KEY = "enlearn.seen.v2";
const KO_CACHE_KEY = "enlearn.kocache.v2";

/**
 * 저장소 상한. 이 값들을 넘기면 브라우저 용량(보통 5MB)을 건드릴 수 있고,
 * 그 경우 setItem이 던지는 예외가 클릭 핸들러까지 번진다.
 */
export const MAX_SEEN = 20_000;
export const MAX_KOREAN_CACHE = 4_000;

/** 푼 문장 기록: 오래된(가장 오래 안 본) 항목부터 버린다 */
function trimSeen(seen: SeenMap): SeenMap {
  const entries = Object.entries(seen);
  if (entries.length <= MAX_SEEN) return seen;
  return Object.fromEntries(
    entries.sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, MAX_SEEN),
  );
}

/** 번역 캐시: JSON에 들어온 순서를 유지하고 앞쪽(오래된) 것부터 버린다 */
function trimKoreanCache(store: Record<string, CachedKorean>): Record<string, CachedKorean> {
  const entries = Object.entries(store);
  if (entries.length <= MAX_KOREAN_CACHE) return store;
  return Object.fromEntries(entries.slice(entries.length - MAX_KOREAN_CACHE));
}

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

/** 이미 받아온 코퍼스 파일(메모리 캐시). 주로 테스트·초기화 확인용. */
export function getCachedCorpus(lane: CorpusLane): CorpusFile | null {
  return fileCache.get(lane) ?? null;
}

/** 코퍼스 JSON을 내려받는다. 실패하면 원인을 사람이 읽을 수 있는 문장으로 준다. */
/** 코퍼스 JSON은 정적 파일이라 30초면 충분히 온다. 그 이상은 연결 문제로 본다. */
const CORPUS_TIMEOUT_MS = 30_000;

/**
 * 호출자만 취소한다. 같은 파일을 기다리는 다른 호출(책 드롭다운 등)은
 * 그대로 두므로, 한 화면의 취소가 다른 화면을 실패시키지 않는다.
 */
function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(new Error("요청을 취소했습니다."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("요청을 취소했습니다."));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export async function loadCorpus(
  lane: CorpusLane,
  signal?: AbortSignal,
): Promise<CorpusFile> {
  const cached = fileCache.get(lane);
  if (cached) return cached;
  // 이미 취소된 신호로는 요청을 시작하지 않는다 (불필요한 트래픽·실패 로그 방지)
  if (signal?.aborted) return Promise.reject(new Error("요청을 취소했습니다."));

  const inflight = pending.get(lane);
  if (inflight) return withAbort(inflight, signal);

  const task = (async () => {
    const url = CORPUS_URLS[lane];
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(CORPUS_TIMEOUT_MS) });
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
  return withAbort(task, signal);
}

// ---------------------------------------------------------------------------
// 푼 문장 기록 (localStorage) — 같은 문장이 계속 나오지 않게 하는 최소 로그
// ---------------------------------------------------------------------------

type SeenMap = Record<string, string>;

const isPlainObject = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 저장된 객체를 읽는다. 같은 문자열은 다시 파싱하지 않는다(리뷰 1-6).
 * ⚠️ 돌려받는 객체는 freeze되어 있다 — 고칠 새에는 새 객체를 만든다.
 */
function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  return parseStored<T>(key, window.localStorage.getItem(key), isPlainObject) ?? fallback;
}

function countKeys(store: object, prefix?: string): number {
  return Object.keys(store).filter((k) => !prefix || k.startsWith(prefix)).length;
}

export function loadSeen(): SeenMap {
  return readJson<SeenMap>(SEEN_KEY, {});
}

export function markSeen(key: string): void {
  if (typeof window === "undefined") return;
  // 읽은 객체를 그대로 고치지 않는다 (파싱 캐시가 같은 객체를 돌려준다)
  const seen = { ...loadSeen(), [key]: new Date().toISOString() };
  safeSetItem(SEEN_KEY, JSON.stringify(trimSeen(seen)));
  notifyProgressOnce();
}

/** 저장된 key 확인. (컴포넌트는 스냅샷을 쓰지만 이 판정은 테스트·internal에서도 쓴다) */
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
  safeSetItem(SEEN_KEY, JSON.stringify(kept));
  notifyProgressOnce();
}

export function seenCount(lane?: CorpusLane): number {
  return countKeys(loadSeen(), lane ? `${lane}:` : undefined);
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
  const store = { ...readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {}) };
  // 값 길이를 줄여 둔다. 이상한 번역이 길게 쌓이면 저장소를 통째로 차지한다.
  store[key] = {
    ko: ko.slice(0, 600),
    hints: hints.slice(0, 6).map((h) => h.slice(0, 40)),
  };
  safeSetItem(KO_CACHE_KEY, JSON.stringify(trimKoreanCache(store)));
  notifyProgressOnce();
}

/** 캐시된 한국어 번역 개수 (설정 화면 표시용) */
export function koreanCacheCount(lane?: CorpusLane): number {
  return countKeys(
    readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {}),
    lane ? `${lane}:` : undefined,
  );
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
  safeSetItem(KO_CACHE_KEY, JSON.stringify(kept));
  notifyProgressOnce();
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
// 두 저장소의 원문을 이어 붙이지 않고 따로 비교한다. 3MB 문자열을 렌더마다
// 새로 만드는 것 자체가 비용이었다(리뷰 1-6).
// undefined는 "아직 계산하지 않음" (localStorage.getItem은 undefined를 돌려주지 않는다)
let progressRawSeen: string | null | undefined = undefined;
let progressRawKorean: string | null | undefined = undefined;
let progressValue: ProgressCounts = EMPTY_PROGRESS;

function notifyProgress(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PROGRESS_EVENT));
}

/** 묶음 쓰기: 한 동작이 여러 저장소를 바꿔도 알림은 한 번만 낸다 (리뷰 3-10) */
let progressBatchDepth = 0;

function notifyProgressOnce(): void {
  if (progressBatchDepth === 0) notifyProgress();
}

export function batchProgress<T>(fn: () => T): T {
  if (typeof window === "undefined") return fn();
  progressBatchDepth += 1;
  try {
    return fn();
  } finally {
    progressBatchDepth -= 1;
    if (progressBatchDepth === 0) notifyProgress();
  }
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
  const rawSeen = window.localStorage.getItem(SEEN_KEY);
  const rawKorean = window.localStorage.getItem(KO_CACHE_KEY);
  if (rawSeen !== progressRawSeen || rawKorean !== progressRawKorean) {
    progressRawSeen = rawSeen;
    progressRawKorean = rawKorean;
    // 두 원문을 한 번만 읽고 개수를 센다 (이전 구현은 4번 읽고 3번 파싱했다)
    const seen = readJson<SeenMap>(SEEN_KEY, {});
    progressValue = {
      daily: countKeys(seen, "daily:"),
      classic: countKeys(seen, "classic:"),
      korean: countKeys(readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {})),
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

// ---------------------------------------------------------------------------
// 백업 / 복원 (다른 기기·브라우저로 연습 기록 옮기기)
// ---------------------------------------------------------------------------

export function exportSeen(): SeenMap {
  return loadSeen();
}

export function exportKoreanCache(): Record<string, CachedKorean> {
  // 읽기 경로는 getCachedKorean에서 값 내부까지 검사하지만, 이 경로는 parseStored의
  // "평면 객체" 검사만 거친 값을 그대로 CachedKorean으로 단언하고 있었다.
  // 그러면 검증되지 않은 항목(hints: [42] 등)이 "검증된 백업"에 그대로 담겨 다른
  // 기기에서 조용히 사라진다(리뷰 2-15). cacheKorean과 같은 클리퍼를 통과시킨다.
  const stored = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  const out: Record<string, CachedKorean> = {};
  for (const [key, value] of Object.entries(stored)) {
    const normalized = normalizeCachedKorean(value);
    if (normalized) out[key] = normalized;
  }
  return out;
}

/** 받은 문장 기록을 합친다(기본) 또는 대체한다. 잘못된 항목은 걸러낸다. */
export function importSeen(value: unknown, replace = false): number {
  if (typeof window === "undefined") return 0;
  const incoming = normalizeRecord(value, (k, v) =>
    k.length > 0 && k.length <= 80 && typeof v === "string",
  );
  if (replace) {
    safeSetItem(SEEN_KEY, JSON.stringify(trimSeen(incoming)));
    notifyProgressOnce();
    return seenCount();
  }
  const merged = trimSeen({ ...loadSeen(), ...incoming });
  safeSetItem(SEEN_KEY, JSON.stringify(merged));
  notifyProgressOnce();
  // 실제로 남은 개수만 알려준다 (상한으로 잘렸을 수 있다)
  const stored = loadSeen();
  return Object.keys(incoming).filter((k) => stored[k] !== undefined).length;
}

/**
 * 백업으로 들어온 번역 캐시 항목을 cacheKorean과 같은 규칙으로 줄인다(리뷰 1-16).
 * 검사만 하고 저장하면 힌트 요소 타입·값 길이가 상한 없이 들어온다.
 */
function normalizeCachedKorean(value: unknown): CachedKorean | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.ko !== "string" || !o.ko.trim()) return null;
  if (!Array.isArray(o.hints)) return null;
  return {
    ko: o.ko.slice(0, 600),
    hints: o.hints
      .filter((h): h is string => typeof h === "string")
      .slice(0, 6)
      .map((h) => h.slice(0, 40)),
  };
}

/** 한국어 번역 캐시를 합친다(기본) 또는 대체한다. */
export function importKoreanCache(value: unknown, replace = false): number {
  if (typeof window === "undefined") return 0;
  const incoming: Record<string, CachedKorean> = {};
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k.length === 0 || k.length > 80) continue;
      const normalized = normalizeCachedKorean(v);
      if (normalized) incoming[k] = normalized;
    }
  }
  if (replace) {
    safeSetItem(KO_CACHE_KEY, JSON.stringify(trimKoreanCache(incoming)));
    notifyProgressOnce();
    return koreanCacheCount();
  }
  // 기존 캐시를 우선한다 (화면에 보여 이미 검증된 번역을 덮어쓰지 않는다)
  const merged = trimKoreanCache({ ...incoming, ...exportKoreanCache() });
  safeSetItem(KO_CACHE_KEY, JSON.stringify(merged));
  notifyProgressOnce();
  const stored = readJson<Record<string, CachedKorean>>(KO_CACHE_KEY, {});
  return Object.keys(incoming).filter((k) => stored[k] !== undefined).length;
}

function normalizeRecord(
  value: unknown,
  accept: (key: string, value: unknown) => boolean,
): Record<string, never> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof k === "string" && accept(k, v)) out[k] = v;
  }
  return out as Record<string, never>;
}

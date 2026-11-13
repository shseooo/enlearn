/**
 * 연습 기록과 간격반복(SRS).
 *
 * - 연습 기록: 채점이 끝난 문장마다 점수·교정 내용을 브라우저에 남긴다.
 *   → 연속 연습일수, 이번 주 연습량, 자주 틀리는 표현을 뽑는 데 쓴다.
 * - SRS: 문장을 복습 큐에 넣고 1/3/7/21/45일 주기로 다시 낸다.
 *   "알고 있어요 / 아슬아슬 / 잊었어요" 자기 평가로 단계가 오른다. (LLM 불필요)
 */
import type { CorpusLane, ImportResult } from "./types";
import { localDateString } from "./corpus";
import { hash64 } from "./corpus-tools";
import { safeSetItem, parseStored } from "./storage";

/** 코퍼스 레인 + 코퍼스가 아닌 경로(자유 작성 / AI 생성) */
export type PracticeLane = CorpusLane | "free" | "ai";

export const LANE_SHORT_LABELS: Record<PracticeLane, string> = {
  daily: "일상 회화",
  classic: "동화 명문장",
  free: "자유 작성",
  ai: "AI 생성",
};

// v2: practiceId가 32비트 shortHash → 64비트 hash64로 바뀌어(D6-5) v1의 id와
// 맞지 않는다. 결정(resolved.md)대로 마이그레이션은 하지 않는다 — v1 키는
// 앱이 열릴 때 죽은 키로 지운다(src/lib/corpus.ts LEGACY_KEYS).
const LOG_KEY = "enlearn.log.v2";
const SRS_KEY = "enlearn.srs.v2";
const CHANGE_EVENT = "enlearn:practice-changed";

/**
 * localStorage를 보호하기 위해 두는 상한 (D4-2로 400 → 2,000)
 *
 * 실측 근거(커밋된 코퍼스 문장으로 만든 실제 형태의 연습 기록 300건의 JSON):
 *  - 1건 평균 381바이트(최대 473). 코퍼스 4,400문장의 평균 en 42.7자 · ko 22.6자.
 *  - 기록 2,000건 ≈ 0.73MB · seen 20,000건 ≈ 0.9MB(17자 키 + ISO 시각 24자)
 *    · 번역 캐시 4,000건 ≈ 0.4MB · 복습 큐 500건 ≈ 0.25MB → 합쳐 약 2.3MB.
 *  localStorage 한도(약 5MB) 안에서 세 저장소를 함께 쓰되 여유를 남기는 값이다.
 *  3,000건도 가능하지만(≈1.1MB) 쓸 때마다 통째로 직렬화하는 비용이 커진다.
 *  옛 키(enlearn.seen.v2 · enlearn.kocache.v2 · enlearn.log.v1 · enlearn.srs.v1)는
 *  앱이 열릴 때 지운다(R7-8/D6-5) — 위 계산은 "지금 저장소"만 센 값이고,
 *  죽은 키 ≈1.3MB가 예산을 몰래 먹는다.
 */
export const MAX_RECORDS = 2_000;
const MAX_CORRECTIONS = 5;
const MAX_TEXT = 400;
/** 저장소 키로 쓰는 id 길이 상한(R5-4). en/ko/answer는 clip으로 이미 자르지만 id만 무제한이었다. */
const MAX_ID_CHARS = 200;
/** 복습 큐 상한. 이걸 넘기면 가장 낮은 단계부터 밀어낸다. */
export const MAX_SRS = 500;

/** 복습 간격(일). stage가 오르면 다음 복습이 멀어진다. */
export const REVIEW_INTERVALS = [1, 3, 7, 21, 45];
export type ReviewGrade = "knows" | "shaky" | "forgot";

// ---------------------------------------------------------------------------
// 날짜 도구 (로컬 달력 기준 — toISOString()은 UTC라 KST 아침에 하루가 바뀐다)
// ---------------------------------------------------------------------------

function parseLocal(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(date: string, days: number): string {
  const d = parseLocal(date);
  d.setDate(d.getDate() + days);
  return localDateString(d);
}

/**
 * 저장소 상한(MAX_RECORDS/MAX_SEEN/MAX_SRS)을 넘기면 "날짜·시각 순으로 정렬해 앞쪽을
 * 버린다". 상한 없는 미래 날짜는 항상 살아남아 실제 학습 기록을 잘라낸다(R4-4).
 * 그래서 백업·저장소에서 읽는 날짜에 상한을 둔다.
 *  - 하한: 2000년보다 앞은 이 앱의 학습 기록이 될 수 없다.
 *  - 상한: 오늘보다 하루 이후부터는 거부한다(기기 시계가 하루 어긋난 경우는 산다).
 *  - 이미 저장된 값은 버리지 않고 오늘로 바로잡는다(읽는 경로에서만 자른다).
 */
const MIN_RECORD_DATE = "2000-01-01";
const IMPORT_DATE_TOLERANCE_DAYS = 1;

/** 외부에서 들어온 날짜가 허용 범위인지 본다(R4-4). */
function isStorableDate(date: string, today = localDateString()): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= MIN_RECORD_DATE &&
    date <= addDays(today, IMPORT_DATE_TOLERANCE_DAYS)
  );
}

/** 이미 저장된 미래 날짜는 오늘로 끌어내린다. 값 자체는 버리지 않는다(R4-4). */
function capStoredDate(date: string, today = localDateString()): string {
  return date > today ? today : date;
}

/** 미래 시각도 정렬에서 앞줄을 차지하지 못한다(R4-4). */
function capStoredTimestamp(ts: number, maxTs: number): number {
  return ts > maxTs ? maxTs : ts;
}

// ---------------------------------------------------------------------------
// 저장소 헬퍼
// ---------------------------------------------------------------------------

const normalizedCache = new Map<string, { raw: string; value: unknown[] }>();

function readArray<T>(key: string, day: string, normalize: (raw: unknown) => T | null): T[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(key);
  if (raw === null) return [];
  // ⚠️ normalize까지 기억한다(storage.ts의 파싱 캐시와 짝을 이루는 "normalize 캐시", R7-7).
  // MAX_RECORDS가 400 → 2,000이 되면서 집계 한 번에 loadLog 3번·loadSrs 4번이
  // 같은 저장소를 통째로 다시 판다(채점 한 번에 약 6,000개 객체 + 수만 개 문자열).
  // 날짜가 키에 들어가는 이유: normalizeRecord·normalizeSrs는 "오늘" 기준으로
  // 미래 날짜를 바로잡으므로, 자정이 지나면 같은 문자열도 새로 정규화해야 한다.
  const cacheKey = `${key}@${day}`;
  const hit = normalizedCache.get(cacheKey);
  if (hit && hit.raw === raw) return hit.value.slice() as T[];
  const parsed = parseStored<unknown[]>(key, raw, Array.isArray) ?? [];
  const value: T[] = [];
  for (const item of parsed) {
    const normalized = normalize(item);
    if (normalized !== null) value.push(normalized);
  }
  // 오래된 "날짜" 조각이 쌓이지 않게 잘라낸다(키 두 개 × 며칠쯤이면 충분하다).
  if (normalizedCache.size > 8) normalizedCache.clear();
  normalizedCache.set(cacheKey, { raw, value });
  // 호출자가 배열을 고쳐도(logPractice는 push한다) 기억은 오염되지 않게 복사해 준다.
  return [...value];
}

/** 그 키에 대한 정규화 기억을 버린다(쓰기가 실패해도 저장소의 이전 값으로 돌아가야 한다). */
function dropNormalized(key: string): void {
  for (const cacheKey of [...normalizedCache.keys()]) {
    if (cacheKey.startsWith(`${key}@`)) normalizedCache.delete(cacheKey);
  }
}

/** 알림 묶음: 한 동작이 여러 저장소를 바꿔도 화면은 한 번만 갱신한다 */
let batchDepth = 0;

function writeArray(key: string, value: unknown[]): boolean {
  if (typeof window === "undefined") return false;
  // 저장 실패(용량 초과 등)는 삼킨다. 예외가 이벤트 핸들러까지 번지면
  // 화면이 멈추고, 그 이유가 "저장 공간"이라는 것을 사용자는 알 수 없다.
  const ok = safeSetItem(key, JSON.stringify(value));
  // 실패 여부와 무관하게 기억을 지운다. 그래야 다음 읽기가 저장소의
  // "실제로 남은 값"을 본다(리뷰 2-4 — 실패한 변경이 화면에 보이면 안 된다).
  dropNormalized(key);
  if (batchDepth === 0) notifyPractice();
  return ok;
}

/** 묶음 쓰기: 연습 기록+SRS처럼 여러 저장소를 한 동작으로 바꿀 때 쓴다 */
export function batchPractice<T>(fn: () => T): T {
  return batch(fn);
}

function batch<T>(fn: () => T): T {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0) notifyPractice();
  }
}

const clampScore = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(v)));
};

const clip = (text: unknown): string =>
  typeof text === "string" ? text.trim().slice(0, MAX_TEXT) : "";

// ---------------------------------------------------------------------------
// 연습 기록
// ---------------------------------------------------------------------------

export interface CorrectionNote {
  original: string;
  better: string;
}

export interface PracticeRecord {
  /** 문장 기준 id (같은 문장의 같은 날 기록은 갱신) */
  id: string;
  /** 로컬 날짜 YYYY-MM-DD */
  date: string;
  ts: number;
  lane: PracticeLane;
  /** 목표 영어 문장 (자유 작성은 사용자가 쓴 문장) */
  en: string;
  ko: string | null;
  /** 사용자가 쓴 영어 */
  answer: string;
  score: number;
  corrections: CorrectionNote[];
}

export interface PracticeInput {
  lane: PracticeLane;
  en: string;
  ko: string | null;
  answer: string;
  score: number;
  corrections?: CorrectionNote[];
  /** 기록 시각(테스트용) */
  now?: Date;
  /**
   * id를 만들 문장. 기본값은 en이지만 AI 생성 연습에서는 en이 모델이 만든
   * 참고 번역이라 풀 때마다 달라진다 → 같은 문장을 여러 번 푸는데 기록이
   * 중복되고 lastAnswerFor가 놓친다. 그런 곳은 사용자 입력(한국어 문장)을 준다.
   */
  anchor?: string;
}

/**
 * 연습 기록·복습 큐의 id(D6-5).
 *
 * entryKey와 같은 64비트 해시를 쓴다. 32비트면 기록 2,000건 + 큐 500건에서도
 * 충돌 기대값이 무시할 수 있는 수준이 아니고, 충돌하면 다른 문장의 진행 상태가
 * 섞인다(logPractice의 id|date 키, gradeReview의 findIndex가 둘을 하나로 다룬다).
 * ⚠️ entryKey(코퍼스 키)와 별개 이름공간이다 — normalizeKey가 아니라 이 함수의
 * 정규화를 쓰므로 값을 함부로 합치지 않는다.
 */
export function practiceId(lane: PracticeLane, sentence: string): string {
  const key = sentence.trim().toLowerCase().replace(/\s+/g, " ");
  return `${lane}:${key.length}:${hash64(key)}`;
}

function isLane(value: unknown): value is PracticeLane {
  return (
    value === "daily" || value === "classic" || value === "free" || value === "ai"
  );
}

function normalizeRecord(r: unknown, today = localDateString()): PracticeRecord | null {
  if (typeof r !== "object" || r === null) return null;
  const v = r as Record<string, unknown>;
  if (typeof v.id !== "string" || !isLane(v.lane)) return null;
  const corrections = Array.isArray(v.corrections)
    ? v.corrections
        .map((c) => {
          if (typeof c !== "object" || c === null) return null;
          const cc = c as Record<string, unknown>;
          const original = clip(cc.original);
          const better = clip(cc.better);
          return original || better ? { original, better } : null;
        })
        .filter((c): c is CorrectionNote => c !== null)
        .slice(0, MAX_CORRECTIONS)
    : [];
  return {
    id: v.id,
    date: typeof v.date === "string" ? capStoredDate(v.date, today) : "",
    ts: typeof v.ts === "number" ? capStoredTimestamp(v.ts, Date.now()) : 0,
    lane: v.lane,
    en: clip(v.en),
    ko: typeof v.ko === "string" ? clip(v.ko) : null,
    answer: clip(v.answer),
    score: clampScore(v.score),
    corrections,
  };
}

export function loadLog(): PracticeRecord[] {
  const today = localDateString();
  return readArray<PracticeRecord>(LOG_KEY, today, (r) => normalizeRecord(r, today));
}

/**
 * 채점이 끝난 문장을 기록한다.
 * 한국어가 있는 코퍼스 문장은 함께 복습 큐에 넣는다(복습의 재료).
 */
export function logPractice(input: PracticeInput): PracticeRecord | null {
  const en = clip(input.en);
  const answer = clip(input.answer);
  if (!answer) return null;

  const now = input.now ?? new Date();
  // anchor가 있으면 그 문장 기준으로 id를 만든다 (AI 생성 연습의 en은 매번 바뀐다)
  const id = practiceId(input.lane, clip(input.anchor) || en || answer);
  const record: PracticeRecord = {
    id,
    date: localDateString(now),
    ts: now.getTime(),
    lane: input.lane,
    en,
    ko: input.ko ? clip(input.ko) : null,
    answer,
    score: clampScore(input.score),
    corrections: (input.corrections ?? [])
      .map((c) => ({ original: clip(c.original), better: clip(c.better) }))
      .filter((c) => c.original || c.better)
      .slice(0, MAX_CORRECTIONS),
  };

  const log = loadLog();
  const sameDay = log.findIndex((r) => r.id === record.id && r.date === record.date);
  if (sameDay >= 0) log[sameDay] = record;
  else log.push(record);

  batch(() => {
    writeArray(LOG_KEY, log.length > MAX_RECORDS ? log.slice(-MAX_RECORDS) : log);
    // 코퍼스 문장만 복습 큐에 넣는다 (AI 창작 문장은 복습 재료로 쓰지 않는다)
    if (
      record.ko &&
      record.en &&
      (record.lane === "daily" || record.lane === "classic")
    ) {
      addForReview({ id, lane: record.lane, en: record.en, ko: record.ko, now });
    }
  });
  return record;
}

export function clearLog(): void {
  writeArray(LOG_KEY, []);
}

/** 마지막 연습 기록 (복습 화면에서 "지난번 내 답"을 보여줄 때 쓴다) */
/** 백업 내보내기용 (loadLog와 같지만 의도를 분명히 한다) */
export function exportLog(): PracticeRecord[] {
  return loadLog();
}

export function lastAnswerFor(id: string): string | null {
  const records = loadLog().filter((r) => r.id === id);
  if (records.length === 0) return null;
  return records[records.length - 1].answer || null;
}

// ---------------------------------------------------------------------------
// 통계 (대시보드)
// ---------------------------------------------------------------------------

export interface PracticeStats {
  total: number;
  today: number;
  week: number;
  /** 연속 연습일. 오늘은 아직 안 풀어도 어제까지 이어지면 유지된다. */
  streak: number;
  avgScore: number;
  distinctDays: number;
  byLane: Record<PracticeLane, number>;
  topMistakes: { original: string; better: string; count: number }[];
}

export function practiceStats(now = new Date()): PracticeStats {
  const log = loadLog();
  const today = localDateString(now);

  const byLane: Record<PracticeLane, number> = {
    daily: 0,
    classic: 0,
    free: 0,
    ai: 0,
  };
  const days = new Set<string>();
  let scoreSum = 0;
  const mistakes = new Map<string, { original: string; better: string; count: number }>();

  for (const r of log) {
    byLane[r.lane] += 1;
    if (r.date) days.add(r.date);
    scoreSum += r.score;
    for (const c of r.corrections) {
      const key = c.original.toLowerCase() || c.better.toLowerCase();
      if (!key) continue;
      const cur = mistakes.get(key);
      if (cur) {
        cur.count += 1;
        if (c.better) cur.better = c.better;
      } else {
        mistakes.set(key, {
          original: c.original || c.better,
          better: c.better,
          count: 1,
        });
      }
    }
  }

  let streak = 0;
  // 어제 또는 오늘에서 거꾸로 세며 연속을 만든다
  let cursor = today;
  if (!days.has(cursor)) {
    cursor = addDays(today, -1);
    if (!days.has(cursor)) streak = 0;
  }
  if (days.has(cursor)) {
    streak = 1;
    while (days.has(addDays(cursor, -1 * streak))) streak += 1;
  }

  const weekStart = addDays(today, -6);
  return {
    total: log.length,
    today: log.filter((r) => r.date === today).length,
    week: log.filter((r) => r.date >= weekStart && r.date <= today).length,
    streak,
    avgScore: log.length ? Math.round(scoreSum / log.length) : 0,
    distinctDays: days.size,
    byLane,
    topMistakes: [...mistakes.values()]
      .sort((a, b) => b.count - a.count || a.original.localeCompare(b.original))
      .slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// 간격반복(SRS)
// ---------------------------------------------------------------------------

export interface SrsItem {
  id: string;
  lane: PracticeLane;
  en: string;
  ko: string;
  /** 0..REVIEW_INTERVALS.length-1 */
  stage: number;
  /** 다음 복습 날짜 (로컬 YYYY-MM-DD) */
  due: string;
  lapses: number;
  lastReviewed: string | null;
}

function normalizeSrs(raw: unknown): SrsItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.en !== "string" || !isLane(v.lane)) {
    return null;
  }
  const ko = typeof v.ko === "string" ? v.ko : "";
  if (!ko) return null;
  const maxStage = REVIEW_INTERVALS.length - 1;
  const stage =
    typeof v.stage === "number" && Number.isFinite(v.stage)
      ? Math.max(0, Math.min(maxStage, Math.round(v.stage)))
      : 0;
  return {
    id: v.id,
    lane: v.lane,
    en: v.en,
    ko,
    stage,
    due: typeof v.due === "string" ? v.due : localDateString(),
    lapses: typeof v.lapses === "number" ? v.lapses : 0,
    lastReviewed: typeof v.lastReviewed === "string" ? v.lastReviewed : null,
  };
}

function loadSrs(): SrsItem[] {
  return readArray<SrsItem>(SRS_KEY, localDateString(), normalizeSrs);
}

/** 복습 큐에 문장을 넣는다. 이미 있으면 진행 상황을 그대로 둔다. */
export function addForReview(item: {
  id: string;
  lane: PracticeLane;
  en: string;
  ko: string;
  now?: Date;
}): void {
  const en = clip(item.en);
  const ko = clip(item.ko);
  if (!item.id || !en || !ko) return;

  const queue = loadSrs();
  if (queue.some((x) => x.id === item.id)) return;
  const today = localDateString(item.now ?? new Date());
  queue.push({
    id: item.id,
    lane: item.lane,
    en,
    ko,
    stage: 0,
    due: addDays(today, REVIEW_INTERVALS[0]),
    lapses: 0,
    lastReviewed: null,
  });
  writeArray(SRS_KEY, trimSrs(queue));
}

/** 오늘(또는 지난) 복습 문장. 오래된 것부터 나온다. */
export function dueItems(now = new Date()): SrsItem[] {
  const today = localDateString(now);
  return loadSrs()
    .filter((x) => x.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || a.stage - b.stage);
}

export function dueCount(now = new Date()): number {
  return dueItems(now).length;
}

/** 큐에서 가장 가까운 future 복습 날짜 (지금은 안 나오는 문장 포함) */
export function nextReviewDate(now = new Date()): string | null {
  const today = localDateString(now);
  const future = loadSrs()
    .filter((x) => x.due > today)
    .sort((a, b) => a.due.localeCompare(b.due));
  return future[0]?.due ?? null;
}

/**
 * 자기 평가로 단계를 움직인다.
 * - 알고 있어요: 단계 +1 (다음 복습이 멀어진다)
 * - 아슬아슬: 단계 유지, 단 한 칸 짧은 간격으로 다시 낸다
 * - 잊었어요: 단계 -2, 실수 횟수 기록
 */
export function gradeReview(
  id: string,
  grade: ReviewGrade,
  now = new Date(),
): SrsItem | null {
  const queue = loadSrs();
  const index = queue.findIndex((x) => x.id === id);
  if (index < 0) return null;

  const maxStage = REVIEW_INTERVALS.length - 1;
  const item = queue[index];
  const today = localDateString(now);

  let intervalIndex = item.stage;
  if (grade === "knows") {
    item.stage = Math.min(maxStage, item.stage + 1);
    intervalIndex = item.stage;
  } else if (grade === "shaky") {
    intervalIndex = Math.max(0, item.stage - 1);
  } else {
    item.stage = Math.max(0, item.stage - 2);
    item.lapses += 1;
    intervalIndex = item.stage;
  }

  item.due = addDays(today, REVIEW_INTERVALS[Math.min(intervalIndex, maxStage)]);
  item.lastReviewed = today;
  queue[index] = item;
  writeArray(SRS_KEY, queue);
  return item;
}

export function srsCount(): number {
  return loadSrs().length;
}

/** 복습 큐 전체 (대기 여부와 무관하게) */
export function reviewItems(): SrsItem[] {
  return loadSrs();
}

export function clearSrs(): void {
  writeArray(SRS_KEY, []);
}

// ---------------------------------------------------------------------------
// 화면 구독 (useSyncExternalStore) — 기록/복습이 바뀌면 즉시 갱신
// ---------------------------------------------------------------------------

export interface PracticeSnapshot {
  total: number;
  today: number;
  week: number;
  streak: number;
  avgScore: number;
  due: number;
  srs: number;
  topMistakes: { original: string; better: string; count: number }[];
}

const EMPTY_SNAPSHOT: PracticeSnapshot = {
  total: 0,
  today: 0,
  week: 0,
  streak: 0,
  avgScore: 0,
  due: 0,
  srs: 0,
  topMistakes: [],
};

// 두 저장소의 원문을 이어 붙이지 않고 따로 비교한다 (큰 문자열 할당 방지, 리뷰 1-6)
// undefined는 "아직 계산하지 않음" (getItem은 undefined를 돌려주지 않는다)
let snapshotRawLog: string | null | undefined = undefined;
let snapshotRawSrs: string | null | undefined = undefined;
// 스냅샷을 계산한 로컬 날짜. due/오늘처럼 날짜로 판정하는 값은 저장소가 그대로여도
// 자정을 넘기면 바뀌므로, 날짜가 다르면 원문 변화 없이 다시 계산한다(리뷰 2-9).
let snapshotDay: string | undefined = undefined;
let snapshotValue: PracticeSnapshot = EMPTY_SNAPSHOT;

function notifyPractice(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * 다음 자정에 알림을 한 번 낸다.
 * 자정에는 저장은 그대로인데 날짜로 판정하는 값만 바뀌므로, 원문 비교만으로는
 * 스냅샷이 새 참조를 만들지 않는다. 자정 타이머가 없는 화면(⚙️ 설정의 "오늘 대기 N")은
 * 어제의 대기 개수를 계속 보여준다(리뷰 1-13의 남은 자리, 리뷰 2-9).
 * 구독이 생긴 시점에 예약하므로 모든 화면이 같은 규칙을 쓰게 된다.
 */
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let midnightScheduledForDay: string | undefined = undefined;
/** 자정 예약은 구독자를 센다. 마지막 구독이 풀리면 타이머도 함께 끊는다(리뷰 3-8). */
let practiceSubscribers = 0;

function cancelMidnightNotify(): void {
  if (midnightTimer !== null) clearTimeout(midnightTimer);
  midnightTimer = null;
  midnightScheduledForDay = undefined;
}

function scheduleMidnightNotify(): void {
  if (typeof window === "undefined") return;
  const now = new Date();
  const today = localDateString(now);
  if (midnightTimer !== null && midnightScheduledForDay === today) return;
  midnightScheduledForDay = today;
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    notifyPractice();
    // 탭을 계속 열어두는 학습 앱이라 다음 자정도 이어서 예약한다
    scheduleMidnightNotify();
  }, midnight.getTime() - now.getTime());
}

export function subscribeToPractice(callback: () => void): () => void {
  practiceSubscribers += 1;
  scheduleMidnightNotify(); // 자정에 저장이 바뀌지 않아도 다시 계산하게 한다(리뷰 2-9)
  window.addEventListener("storage", callback); // 다른 탭 변경
  window.addEventListener(CHANGE_EVENT, callback);
  let released = false;
  return () => {
    if (released) return; // 같은 cleanup을 두 번 불러 카운트가 깨지지 않게 한다
    released = true;
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
    practiceSubscribers -= 1;
    if (practiceSubscribers === 0) cancelMidnightNotify();
  };
}

/** 값이 바뀐 뒤에야 새 참조를 돌려준다 (무한 재렌더 방지) */
export function getPracticeSnapshot(): PracticeSnapshot {
  const rawLog = window.localStorage.getItem(LOG_KEY);
  const rawSrs = window.localStorage.getItem(SRS_KEY);
  const day = localDateString();
  if (
    rawLog !== snapshotRawLog ||
    rawSrs !== snapshotRawSrs ||
    day !== snapshotDay
  ) {
    snapshotRawLog = rawLog;
    snapshotRawSrs = rawSrs;
    snapshotDay = day;
    const stats = practiceStats();
    snapshotValue = {
      total: stats.total,
      today: stats.today,
      week: stats.week,
      streak: stats.streak,
      avgScore: stats.avgScore,
      due: dueCount(),
      srs: srsCount(),
      topMistakes: stats.topMistakes,
    };
  }
  return snapshotValue;
}

export function getPracticeServerSnapshot(): PracticeSnapshot {
  return EMPTY_SNAPSHOT;
}

// ---------------------------------------------------------------------------
// 주간 집계 (그래프용)
// ---------------------------------------------------------------------------

export interface WeekBucket {
  /** 그 주의 월요일 (로컬 달력 YYYY-MM-DD) */
  start: string;
  end: string;
  /** 화면에 띄울 짧은 라벨 (3.9) */
  label: string;
  count: number;
  avgScore: number;
  mistakes: number;
}

/** 오늘(로컬 달력 YYYY-MM-DD). 화면에서 Date를 직접 만들지 않게 여기서만 제공한다. */
export function localToday(now = new Date()): string {
  return localDateString(now);
}

/** 주 시작(월요일)을 구한다. getDay()는 로컬 기준으로 동작한다. */
function weekStart(date: Date): string {
  const d = new Date(date.getTime());
  d.setHours(12, 0, 0, 0);
  const dow = d.getDay(); // 0=일요일
  d.setDate(d.getDate() - ((dow + 6) % 7));
  return localDateString(d);
}

/** 최근 n주 집계 (오래된 주 → 최신 주 순서) */
export function weeklySeries(weeks = 8, now = new Date()): WeekBucket[] {
  const buckets = new Map<string, { count: number; total: number; mistakes: number }>();
  const startOfCurrent = weekStart(now);
  for (let i = weeks - 1; i >= 0; i--) {
    buckets.set(addDays(startOfCurrent, -i * 7), { count: 0, total: 0, mistakes: 0 });
  }
  for (const r of loadLog()) {
    const key = addDays(weekStart(parseLocal(r.date)), 0);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.count += 1;
    bucket.total += r.score;
    bucket.mistakes += r.corrections.length;
  }
  return [...buckets.entries()].map(([start, b]) => {
    const s = parseLocal(start);
    return {
      start,
      end: addDays(start, 6),
      label: `${s.getMonth() + 1}.${s.getDate()}`,
      count: b.count,
      avgScore: b.count ? Math.round(b.total / b.count) : 0,
      mistakes: b.mistakes,
    };
  });
}

// ---------------------------------------------------------------------------
// 백업 / 복원
// ---------------------------------------------------------------------------

/** 외부 JSON에서 받은 기록을 안전한 형태로 줄인다. (이상한 값이 들어가도 화면이 안 깨지게) */
function sanitizeRecord(value: unknown): PracticeRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const rawDate = typeof o.date === "string" ? o.date : "";
  // 형식만 보고 통과시키면 미래 날짜가 상한 트림에서 실제 기록을 밀어낸다(R4-4).
  // 백업 경계에서는 거부하고, importLog가 "실제로 들어간 개수"를 알려주므로 사용자는 알아챈다.
  if (!isStorableDate(rawDate)) return null;
  // 하루 어긋난 시계는 살리되 저장에는 오늘로 적는다 — 저장에 미래 날짜를 남기지 않는다.
  const date = capStoredDate(rawDate);
  const en = typeof o.en === "string" ? clip(o.en) : "";
  const lane = o.lane;
  if (!en) return null;
  if (lane !== "daily" && lane !== "classic" && lane !== "ai" && lane !== "free") return null;
  // id는 clip 대상이 아니었다(R5-4): 수천 자 id를 저장하면 이후 모든 쓰기에서
  // 통째로 직렬화된다. 너무 길면 화면에 보이는 문장(en) 기준으로 다시 만든다.
  const rawId = typeof o.id === "string" ? o.id : "";
  const id =
    rawId && rawId.length <= MAX_ID_CHARS ? rawId : practiceId(lane, en);
  const corrections = Array.isArray(o.corrections)
    ? o.corrections
        .map((c) => {
          if (typeof c !== "object" || c === null) return null;
          const x = c as Record<string, unknown>;
          if (typeof x.original !== "string" || typeof x.better !== "string") return null;
          return { original: clip(x.original), better: clip(x.better) };
        })
        .filter((c): c is CorrectionNote => c !== null)
        // 하드코딩한 20개를 쓰면 loadLog()가 5개로 잘라 읽은 뒤 다음 쓰기가 남은
        // 교정을 지워버린다 — "저장한 개수 = 읽히는 개수"로 맞춘다(리뷰 3-7).
        .slice(0, MAX_CORRECTIONS)
    : [];
  const scoreRaw = typeof o.score === "number" ? o.score : Number(o.score);
  const tsRaw = typeof o.ts === "number" ? o.ts : Number(o.ts);
  const maxTs = Date.now() + IMPORT_DATE_TOLERANCE_DAYS * 86_400_000;
  return {
    id,
    lane,
    date,
    ts: Number.isFinite(tsRaw) ? capStoredTimestamp(tsRaw, maxTs) : parseLocal(date).getTime(),
    en,
    ko: typeof o.ko === "string" ? clip(o.ko) : null,
    answer: clip(typeof o.answer === "string" ? o.answer : ""),
    score: Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0,
    corrections,
  };
}

function sanitizeSrs(value: unknown): SrsItem | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id ? o.id : "";
  const due = typeof o.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.due) ? o.due : "";
  const en = typeof o.en === "string" ? clip(o.en) : "";
  const ko = typeof o.ko === "string" ? clip(o.ko) : "";
  const lane = o.lane;
  if (!id || !due || !en || !ko) return null;
  if (lane !== "daily" && lane !== "classic") return null;
  // 연습 기록과 같은 규칙(R5-4): 지나치게 긴 id는 문장 기준으로 다시 만든다.
  const safeId = id.length <= MAX_ID_CHARS ? id : practiceId(lane, en);
  const stage = typeof o.stage === "number" ? o.stage : Number(o.stage);
  const lapses = typeof o.lapses === "number" ? o.lapses : Number(o.lapses);
  return {
    id: safeId,
    lane,
    en,
    ko,
    stage: Number.isFinite(stage) ? Math.max(0, Math.min(REVIEW_INTERVALS.length - 1, Math.round(stage))) : 0,
    due,
    lapses: Number.isFinite(lapses) && lapses > 0 ? Math.round(lapses) : 0,
    lastReviewed:
      typeof o.lastReviewed === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.lastReviewed)
        ? o.lastReviewed
        : null,
  };
}

/** 큐가 상한을 넘으면 진척도가 낮은 것부터 밀어낸다 (새로 들어온 문장은 단계 0) */
function trimSrs(queue: SrsItem[]): SrsItem[] {
  if (queue.length <= MAX_SRS) return queue;
  return [...queue]
    .sort((a, b) => b.stage - a.stage || a.due.localeCompare(b.due))
    .slice(0, MAX_SRS);
}

/** 기록을 날짜·시각 순으로 정렬한다(상한으로 자르는 두 경로가 같은 기준을 쓴다, R6-7). */
function sortRecords(records: PracticeRecord[]): PracticeRecord[] {
  return [...records].sort(
    (a, b) => a.date.localeCompare(b.date) || a.ts - b.ts,
  );
}

/**
 * SRS 항목끼리 "누가 이기나"(D2-1): lastReviewed가 더 최근인 값.
 * null(아직 복습하지 않음)은 0으로 본다. 같은 시각이면 기존 값이 이긴다(`>`만 쓴다).
 */
function srsWins(candidate: SrsItem, existing: SrsItem): boolean {
  const a = candidate.lastReviewed ? Date.parse(candidate.lastReviewed) : 0;
  const b = existing.lastReviewed ? Date.parse(existing.lastReviewed) : 0;
  return a > b;
}

/**
 * 연습 기록을 불러온다. 병합은 "누가 이기나"를 시각으로 정한다(D2-1):
 * 같은 id·날짜에서는 ts가 더 최근인 값이 남고, 시각이 같으면 기존 값이 남는다.
 * replace: 기존 기록을 모두 지운다(정렬 후 상한만큼 남긴다).
 */
export function importLog(items: unknown[], replace = false): ImportResult {
  const incoming = items
    .map(sanitizeRecord)
    .filter((r): r is PracticeRecord => r !== null);
  const rejected = items.length - incoming.length;
  if (replace) {
    // 대체는 유효 항목이 0개여야 실제로 비워야 한다 (그렇지 않으면 "지웠다"가 거짓이 된다)
    // ⚠️ 파일에 적힌 순서로 자르면 내림차순 백업에서 가장 최근 기록이 먼저 버려진다(R6-7).
    //    병합 경로와 같은 키(date, ts)로 정렬한 뒤 뒤쪽(최신)만 남긴다.
    // ⚠️ 대체도 병합과 같은 키(id|date)로 접는다(R8-1). 두 백업을 이어붙인 파일은 같은
    //    키를 두 번 담는다. 그대로 두면 같은 문장이 두 행으로 저장되어 통계가 이중
    //    계산되고, logPractice의 findIndex가 첫 행만 고쳐 낡은 행이 계속 남는다.
    const folded = new Map<string, PracticeRecord>();
    for (const r of incoming) {
      const key = `${r.id}|${r.date}`;
      const existing = folded.get(key);
      if (!existing || r.ts > existing.ts) folded.set(key, r);
    }
    const kept = sortRecords([...folded.values()]).slice(-MAX_RECORDS);
    // 쓰기가 실패하면 loadLog()는 이전 저장소를 읽는다. 그 개수를 stored로 보여주면
    // trimmed가 음수가 된다(R8-1). 실패 자체는 writeFailureCount/writeFailed로 전달된다.
    const stored = writeArray(LOG_KEY, kept) ? kept.length : 0;
    return {
      stored,
      rejected,
      // 저장소 상한(MAX_RECORDS)으로 밀려난 개수 — 음수가 되지 않는다.
      trimmed: folded.size - kept.length,
      // 같은 파일 안에서 더 최근 사본에 밀린 중복 사본(병합 경로의 merged와 같은 뜻).
      merged: incoming.length - folded.size,
    };
  }
  if (!incoming.length) return { stored: 0, rejected, trimmed: 0, merged: 0 };
  const byIdDate = new Map<string, PracticeRecord>();
  for (const r of loadLog()) byIdDate.set(`${r.id}|${r.date}`, r);
  // 이 항목의 값이 병합 결과의 "승자"가 된 키. 마지막에 이긴 항목만 남는다.
  const won = new Set<string>();
  for (const r of incoming) {
    const key = `${r.id}|${r.date}`;
    const existing = byIdDate.get(key);
    // D2-1: 더 최근 시각이 이긴다. 시각이 같으면 기존 값(이미 화면에서 본 값)을 지킨다.
    if (!existing || r.ts > existing.ts) {
      byIdDate.set(key, r);
      won.add(key);
    }
  }
  const merged = sortRecords([...byIdDate.values()]);
  writeArray(LOG_KEY, merged.slice(-MAX_RECORDS));
  // stored는 "들어온 값이 들어간 개수"(R7-1). 더 최근 기존 기록에 밀린 항목은
  // 저장소에 키가 있다는 사실만 세면 안 된다 — 적용되지 않은 것을 합친 것처럼 보인다.
  const present = new Set(loadLog().map((r) => `${r.id}|${r.date}`));
  const stored = [...won].filter((k) => present.has(k)).length;
  return {
    stored,
    rejected,
    // 상한(MAX_RECORDS)으로 실제로 밀려난 항목만 trimmed에 넣는다.
    trimmed: won.size - stored,
    // 기존 값이 이긴 항목 + 같은 파일 안에서 자기보다 최근 사본에 밀린 중복 항목.
    merged: incoming.length - won.size,
  };
}

/**
 * 복습 큐를 불러온다. 병합은 마지막 복습 시각(lastReviewed)이 더 최근인 값을 남긴다(D2-1).
 * lastReviewed가 null(아직 복습하지 않음)은 "가장 오래된 값"으로 본다 — 결정이 명시하지 않은
 * 자리라 여기서 규정한다: 새로 들어온 항목이 기존 진행을 되돌리려면 실제로 복습한 뒤여야 한다.
 */
export function importSrs(items: unknown[], replace = false): ImportResult {
  const incoming = items
    .map(sanitizeSrs)
    .filter((x): x is SrsItem => x !== null);
  const rejected = items.length - incoming.length;
  if (replace) {
    // 대체도 병합과 같은 키(id)로 접는다(R8-1). 중복이 남으면 gradeReview가 findIndex로
    // 하나만 고치므로 나머지 하나는 due가 그대로 남아 복습 탭에서 계속 나온다.
    const folded = new Map<string, SrsItem>();
    for (const x of incoming) {
      const existing = folded.get(x.id);
      if (!existing || srsWins(x, existing)) folded.set(x.id, x);
    }
    const kept = trimSrs([...folded.values()]);
    const stored = writeArray(SRS_KEY, kept) ? kept.length : 0;
    return {
      stored,
      rejected,
      trimmed: folded.size - kept.length,
      merged: incoming.length - folded.size,
    };
  }
  if (!incoming.length) return { stored: 0, rejected, trimmed: 0, merged: 0 };
  const byId = new Map<string, SrsItem>();
  for (const x of loadSrs()) byId.set(x.id, x);
  const won = new Set<string>();
  for (const x of incoming) {
    const existing = byId.get(x.id);
    if (!existing) {
      byId.set(x.id, x);
      won.add(x.id);
      continue;
    }
    if (srsWins(x, existing)) {
      byId.set(x.id, x);
      won.add(x.id);
    }
  }
  writeArray(SRS_KEY, trimSrs([...byId.values()]));
  // stored는 "들어온 값이 들어간 개수"(R7-1): trimSrs로 밀려난 것까지 세지 않는다.
  const present = new Set(loadSrs().map((x) => x.id));
  const stored = [...won].filter((id) => present.has(id)).length;
  return {
    stored,
    rejected,
    trimmed: won.size - stored,
    merged: incoming.length - won.size,
  };
}

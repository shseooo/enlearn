/**
 * 연습 기록과 간격반복(SRS).
 *
 * - 연습 기록: 채점이 끝난 문장마다 점수·교정 내용을 브라우저에 남긴다.
 *   → 연속 연습일수, 이번 주 연습량, 자주 틀리는 표현을 뽑는 데 쓴다.
 * - SRS: 문장을 복습 큐에 넣고 1/3/7/21/45일 주기로 다시 낸다.
 *   "알고 있어요 / 아슬아슬 / 잊었어요" 자기 평가로 단계가 오른다. (LLM 불필요)
 */
import type { CorpusLane } from "./types";
import { localDateString } from "./corpus";
import { shortHash } from "./corpus-tools";

/** 코퍼스 레인 + 코퍼스가 아닌 경로(자유 작성 / AI 생성) */
export type PracticeLane = CorpusLane | "free" | "ai";

export const LANE_SHORT_LABELS: Record<PracticeLane, string> = {
  daily: "일상 회화",
  classic: "동화 명문장",
  free: "자유 작성",
  ai: "AI 생성",
};

const LOG_KEY = "enlearn.log.v1";
const SRS_KEY = "enlearn.srs.v1";
const CHANGE_EVENT = "enlearn:practice-changed";

/** localStorage를 보호하기 위해 두는 상한 */
const MAX_RECORDS = 400;
const MAX_CORRECTIONS = 5;
const MAX_TEXT = 400;

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

/** 두 로컬 날짜 사이의 일수 (b - a) */
export function daysBetween(a: string, b: string): number {
  return Math.round(
    (parseLocal(b).getTime() - parseLocal(a).getTime()) / 86_400_000,
  );
}

// ---------------------------------------------------------------------------
// 저장소 헬퍼
// ---------------------------------------------------------------------------

function readArray<T>(key: string): T[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** 알림 묶음: 한 동작이 여러 저장소를 바꿔도 화면은 한 번만 갱신한다 */
let batchDepth = 0;

function writeArray(key: string, value: unknown[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
  if (batchDepth === 0) notifyPractice();
}

function batch(fn: () => void): void {
  batchDepth += 1;
  try {
    fn();
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
}

export function practiceId(lane: PracticeLane, sentence: string): string {
  const key = sentence.trim().toLowerCase().replace(/\s+/g, " ");
  return `${lane}:${key.length}:${shortHash(key)}`;
}

function isLane(value: unknown): value is PracticeLane {
  return (
    value === "daily" || value === "classic" || value === "free" || value === "ai"
  );
}

function normalizeRecord(r: unknown): PracticeRecord | null {
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
    date: typeof v.date === "string" ? v.date : "",
    ts: typeof v.ts === "number" ? v.ts : 0,
    lane: v.lane,
    en: clip(v.en),
    ko: typeof v.ko === "string" ? clip(v.ko) : null,
    answer: clip(v.answer),
    score: clampScore(v.score),
    corrections,
  };
}

export function loadLog(): PracticeRecord[] {
  return readArray<unknown>(LOG_KEY)
    .map(normalizeRecord)
    .filter((r): r is PracticeRecord => r !== null);
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
  const id = practiceId(input.lane, en || answer);
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
  return readArray<unknown>(SRS_KEY)
    .map(normalizeSrs)
    .filter((x): x is SrsItem => x !== null);
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
  writeArray(SRS_KEY, queue);
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

let snapshotRaw: string | null = null;
let snapshotValue: PracticeSnapshot = EMPTY_SNAPSHOT;

function notifyPractice(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeToPractice(callback: () => void): () => void {
  window.addEventListener("storage", callback); // 다른 탭 변경
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/** 값이 바뀐 뒤에야 새 참조를 돌려준다 (무한 재렌더 방지) */
export function getPracticeSnapshot(): PracticeSnapshot {
  const raw = `${window.localStorage.getItem(LOG_KEY) ?? ""}|${
    window.localStorage.getItem(SRS_KEY) ?? ""
  }`;
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
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
  const date = typeof o.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : null;
  const en = typeof o.en === "string" ? clip(o.en) : "";
  const lane = o.lane;
  if (!date || !en) return null;
  if (lane !== "daily" && lane !== "classic" && lane !== "ai" && lane !== "free") return null;
  const corrections = Array.isArray(o.corrections)
    ? o.corrections
        .map((c) => {
          if (typeof c !== "object" || c === null) return null;
          const x = c as Record<string, unknown>;
          if (typeof x.original !== "string" || typeof x.better !== "string") return null;
          return { original: clip(x.original), better: clip(x.better) };
        })
        .filter((c): c is CorrectionNote => c !== null)
        .slice(0, 20)
    : [];
  const scoreRaw = typeof o.score === "number" ? o.score : Number(o.score);
  const tsRaw = typeof o.ts === "number" ? o.ts : Number(o.ts);
  return {
    id: typeof o.id === "string" && o.id ? o.id : practiceId(lane, en),
    lane,
    date,
    ts: Number.isFinite(tsRaw) ? tsRaw : parseLocal(date).getTime(),
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
  const stage = typeof o.stage === "number" ? o.stage : Number(o.stage);
  const lapses = typeof o.lapses === "number" ? o.lapses : Number(o.lapses);
  return {
    id,
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

/**
 * 연습 기록을 불러온다.
 * merge(기본): 같은 id·날짜는 새 값으로 바꾸고 나머지는 합친다.
 * replace: 기존 기록을 모두 지운다.
 */
export function importLog(items: unknown[], replace = false): number {
  const incoming = items
    .map(sanitizeRecord)
    .filter((r): r is PracticeRecord => r !== null);
  if (replace) {
    // 대체는 유효 항목이 0개여야 실제로 비워야 한다 (그렇지 않으면 "지웠다"가 거짓이 된다)
    writeArray(LOG_KEY, incoming.slice(-MAX_RECORDS));
    return incoming.length;
  }
  if (!incoming.length) return 0;
  const byIdDate = new Map<string, PracticeRecord>();
  for (const r of loadLog()) byIdDate.set(`${r.id}|${r.date}`, r);
  for (const r of incoming) byIdDate.set(`${r.id}|${r.date}`, r);
  const merged = [...byIdDate.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.ts - b.ts,
  );
  writeArray(LOG_KEY, merged.slice(-MAX_RECORDS));
  return incoming.length;
}

/** 복습 큐를 불러온다. 병합할 때는 이미 멀리 미뤄진 쪽을 남겨 진행을 되돌리지 않는다. */
export function importSrs(items: unknown[], replace = false): number {
  const incoming = items
    .map(sanitizeSrs)
    .filter((x): x is SrsItem => x !== null);
  if (replace) {
    writeArray(SRS_KEY, incoming);
    return incoming.length;
  }
  if (!incoming.length) return 0;
  const byId = new Map<string, SrsItem>();
  for (const x of loadSrs()) byId.set(x.id, x);
  for (const x of incoming) {
    const existing = byId.get(x.id);
    if (!existing) {
      byId.set(x.id, x);
      continue;
    }
    const keep =
      x.stage > existing.stage ||
      (x.stage === existing.stage && x.due > existing.due) ||
      (x.due === existing.due && x.lapses < existing.lapses)
      ? x
      : existing;
    byId.set(x.id, keep);
  }
  writeArray(SRS_KEY, [...byId.values()]);
  return incoming.length;
}

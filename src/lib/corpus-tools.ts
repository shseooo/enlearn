/**
 * 코퍼스 빌드/학습에 쓰는 순수 함수들.
 * 네트워크 의존이 전혀 없어서 단위 테스트로 검증한다.
 */
import type { CorpusEntry, Difficulty } from "./types";

/** Gutenberg 본문 앞뒤의 머리말/꼬리말(boilerplate) 마커 */
const PG_START = /^\*\*\*\s*START OF (?:THE )?PROJECT GUTENBERG.*$/im;
const PG_END = /^\*\*\*\s*END OF (?:THE )?PROJECT GUTENBERG.*$/im;

/** 화면에 쓰는 짧은 난이도 이름 (프롬프트용 긴 설명과 분리) */
export const DIFFICULTY_SHORT: Record<Difficulty, string> = {
  easy: "쉬움",
  normal: "보통",
  hard: "어려움",
};

/** 문장 끝으로 취급하면 안 되는 약어 (점 뒤에 대문자가 와도 분할하지 않는다) */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "miss", "ms", "dr", "st", "prof", "jr", "sr", "hon", "rev",
  "capt", "col", "gen", "sen", "gov", "esq", "no", "vs", "etc", "viz", "i.e",
  "e.g", "approx", "fig", "ph.d", "lieut", "hon.",
]);

/** 영어 기능어(Stopword) — 난이도 계산과 힌트 선택에서 제외한다 */
const STOPWORDS = new Set(
  `a an the and or but if so as of to in on at by for with from into over under
   it its this that these those he she they them his her their there here you your
   i me my we us our is am are was were be been being do does did done have has had
   having will would shall should can could may might must not no nor than then too
   very so such what when where which who whom whose why how all any some such own
   same up out off again once also just only more most other another both each few
   about against between while during before after above below s t re ve ll d m
   him himself herself itself myself yourself yourselves anybody anyone anything
   everybody everyone everything nobody nothing somebody someone something none
   one ones somebody`
    .split(/\s+/),
);

/** 코퍼스를 못 내려받아도 난이도 계산이 망가지지 않도록 쓰는 최소 핵심 어휘 */
const CORE_WORDS = new Set(
  `go going went gone come coming came see saw seen know knew want wanted get got
   make made take took give gave say said tell told ask asked eat drinking drink
   water milk bread house home door window look looked want play played child
   children boy girl man woman king queen cat dog rabbit fox crow moon sun star
   tree river little large big small good bad happy sad new old long short day
   night morning friend mother father heart hand eye face head word words very
   not very much many little few`.split(/\s+/),
);

/** 대문자·구두점을 걷어낸 비교 키 (중복 문장 제거용) */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9\u3130-\uD7FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 대용 어휘 집합으로 코어 단어 여부를 판단한다 */
export function isCoreWord(word: string, stats: CorpusStats): boolean {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return true;
  if (STOPWORDS.has(w) || CORE_WORDS.has(w)) return true;
  return (stats.freq.get(w) ?? 0) >= stats.coreThreshold;
}

/** 공백 기준 어절 중 실제 단어만 남긴다 */
export function words(text: string): string[] {
  return text
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .split(/\s+/)
    .map((w) => w.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, ""))
    .filter(Boolean);
}

/** Gutenberg 상여를 잘라내고 본문만 남긴다 */
export function stripGutenbergBoilerplate(text: string): string {
  const start = text.split(PG_START);
  const body = start.length > 1 ? start[1] : text;
  const end = body.split(PG_END);
  return end[0];
}

/** Wikisource 원문(wikitext)에서 마크업/템플릿을 제거한다 */
export function stripWikisourceMarkup(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/<\/?[a-z][a-z0-9]*(?:\s[^>]*)?>/gi, " ")
    .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/^[=!]{2,}.*$/gm, "")
    .replace(/<\/?onlyinclude>/gi, "");
}

/**
 * 줄바꿈·하이픈·특수 문자를 정리해 문장 나누기 좋은 흐름으로 만든다.
 * - 줄 끝 하이픈 + 소문자 시작 → 단어를 이어 붙인다 (Gutenberg 줄바꿈 하이픈)
 * - 빈 줄은 유지(문단 구분), 그 외 줄바꿈은 공백으로
 * - 합자(ﬁ), 구식 큰따옴표를 정규화
 */
export function normalizeProse(text: string): string {
  return text
    .replace(/\u00ad/g, "")
    .replace(/\ufb01/g, "fi")
    .replace(/\ufb02/g, "fl")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d\u00ab\u00bb]/g, '"')
    .replace(/([A-Za-z])-\r?\n([a-z])/g, "$1$2")
    .replace(/\r\n/g, "\n")
    // 줄바꿈은 모두 공백으로 바꾼다 (문장 경계는 구두점으로 판단한다)
    .replace(/\n+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** 약어·말줄임표·따옴표를 고려해 텍스트를 문장으로 나눈다 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const tokens = text.split(/(\s+)/);
  const n = tokens.length;

  // tokens.slice(i + 1).find(...)는 토큰마다 나머지 배열을 복사해 O(n²)이었다
  // (책 한 권 200k 토큰에 5초). 뒤에서 한 번 훑어 "다음 실단어 인덱스"를 O(n)으로 준비한다.
  const isSpace: boolean[] = new Array(n);
  for (let i = 0; i < n; i++) isSpace[i] = /^\s+$/.test(tokens[i]);
  const nextWord = new Int32Array(n).fill(-1);
  let lastWord = -1;
  for (let i = n - 1; i >= 0; i--) {
    nextWord[i] = lastWord;
    if (!isSpace[i]) lastWord = i;
  }

  let buf = "";

  for (let i = 0; i < n; i++) {
    if (isSpace[i]) {
      buf += tokens[i];
      continue;
    }
    buf += tokens[i];

    // 다음 토큰이 새 문장(대문자/따옴표 시작)인지 본다
    const nextWordIndex = nextWord[i];
    if (nextWordIndex < 0) continue;

    const closed = buf.replace(/[\s\u00a0]+$/, "");
    const tail = closed.replace(/["')\]\u201d]+$/, "");
    const lastChar = tail.slice(-1);
    if (!".!?".includes(lastChar)) continue;

    const beforeDot = tail.slice(0, -1).split(/\s+/).pop() ?? "";
    if (ABBREVIATIONS.has(beforeDot.toLowerCase())) continue;
    if (/\.\s*\.\s*\.$/.test(tail) || tail.endsWith("\u2026")) continue;
    // "he said." 뒤의 대문자처럼 보이지만 실제로는 인용 시작인 경우도 허용
    if (!/^[A-Z"\u201c]/.test(tokens[nextWordIndex].slice(0, 1))) continue;

    out.push(closed.trim());
    buf = "";
  }

  const rest = buf.trim();
  if (rest) out.push(rest);
  return out;
}

/** 연습 문장으로 쓸 만한지 판단한다. (짧은 대사와 장황한 서술을 걸러낸다) */
export function isPracticeSentence(
  sentence: string,
  options: { minWords?: number; maxWords?: number } = {},
): boolean {
  const min = options.minWords ?? 6;
  const max = options.maxWords ?? 18;
  const s = sentence.trim();
  if (!s) return false;
  if (!/^[A-Z"\u201c]/.test(s)) return false;
  if (!/["'\])\u201d]?[.!?]$/.test(s)) return false;

  const w = words(s);
  if (w.length < min || w.length > max) return false;

  // OCR 노이즈·비영어 문자·과도한 구두점 제거
  if (/[^A-Za-z0-9\s.,!?;:'"\u2014\u2019()\u2026-]/.test(s)) return false;
  if ((s.match(/[,;]/g) ?? []).length > 3) return false;
  if ((s.match(/["\u201c]/g) ?? []).length > 2) return false;
  if ((s.match(/\d/g) ?? []).length > 3) return false;
  // 전부 대문자인 문장(장 제목 등) 제외
  if (s === s.toUpperCase()) return false;
  // "Chapter I", "by the same author" 같은 부속물 제외
  if (/^(chapter|book|volume|illustrated|frontispiece|note by|preface)\b/i.test(s))
    return false;
  // 동사 없이 나열된 구(제목·목차) 제외
  const hasVerb = w.some((x) =>
    /(ing|ed|ed'|s)$/.test(x.toLowerCase()) ||
    ["is", "are", "was", "were", "be", "am", "do", "does", "did", "said", "had",
     "has", "have", "will", "would", "can", "could", "must", "shall", "should",
     "may", "might", "sat", "stood", "went", "came", "ran", "cried", "asked"]
      .includes(x.toLowerCase()),
  );
  if (!hasVerb) return false;
  return true;
}

/** 어휘 빈도와, 그 코퍼스에서 "자주 쓰는 단어"로 볼 기준선 */
export interface CorpusStats {
  freq: Map<string, number>;
  /** 코퍼스 크기가 바뀌어도 흔들리지 않도록 문장 수에 비례해 정한다 */
  coreThreshold: number;
  /** lane 안 백분위로 정한 난이도 기준선 (없으면 GRADE_THRESHOLDS 절대값) */
  gradeCutoffs?: GradeCutoffs;
}

/** 백분위 기반 난이도 기준선 (score ≤ easy → 쉬움, ≥ hard → 어려움) */
export interface GradeCutoffs {
  easy: number;
  hard: number;
}

/** 어휘 빈도 지도를 만든다 (코퍼스 전체 영어 문장에서) */
export function buildFrequency(sentences: string[]): CorpusStats {
  const freq = new Map<string, number>();
  for (const s of sentences) {
    for (const raw of words(s)) {
      const w = raw.toLowerCase().replace(/[^a-z']/g, "");
      if (!w || w.length < 2) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  return {
    freq,
    coreThreshold: Math.max(2, Math.round(sentences.length * 0.004)),
  };
}

/** 난이도 분리를 위한 문장 특징 */
export interface DifficultyParts {
  wordCount: number;
  rare: number;
  clauses: number;
  score: number;
}

/** 문장에서 어절 수 / 희귀 어휘 수 / 절 수를 센다 */
export function difficultyParts(
  sentence: string,
  stats: CorpusStats,
): DifficultyParts {
  const w = words(sentence);
  const content = w.filter((x) => !STOPWORDS.has(x.toLowerCase()));
  const rare = content.filter((x) => !isCoreWord(x, stats)).length;
  const clauses =
    (sentence.match(/[,;]/g) ?? []).length +
    (sentence.match(/\b(that|which|when|because|although|while|until)\b/gi) ?? [])
      .length;
  return { wordCount: w.length, rare, clauses, score: w.length + rare * 2.5 + clauses * 2 };
}

/**
 * 규칙 기반 난이도. (LLM 호출 없이 결정론적으로)
 * 어절 수 + 절 연결어 개수 + 희귀 어휘 비율을 합산해 나눈다.
 *
 * stats.gradeCutoffs가 있으면 lane 안 백분위로 판단한다.
 * 절대값(GRADE_THRESHOLDS)만 쓰면 19세기 문체는 무조건 어려움이 되어
 * classic lane의 71%가 hard로 몰렸다 (쉬움 필터가 114문장만 남는 문제).
 */
export const GRADE_THRESHOLDS = {
  hardScore: 25,
  hardWords: 14,
  hardRare: 3,
  easyScore: 13,
  easyWords: 8,
  easyRare: 1,
};

/** 문장 점수 분포에서 쉬움/어려움 기준선을 백분위로 정한다. */
export function computeGradeCutoffs(
  sentences: string[],
  stats: CorpusStats,
  options: { easyRatio?: number; hardRatio?: number } = {},
): GradeCutoffs {
  const easyRatio = options.easyRatio ?? 0.3;
  const hardRatio = options.hardRatio ?? 0.3;
  const scores = sentences
    .map((s) => difficultyParts(s, stats).score)
    .sort((a, b) => a - b);
  if (scores.length === 0) return { easy: 0, hard: 0 };
  const at = (q: number): number => {
    const i = Math.min(scores.length - 1, Math.max(0, Math.floor(scores.length * q)));
    return scores[i];
  };
  return { easy: at(easyRatio), hard: at(1 - hardRatio) };
}

export function gradeDifficulty(
  sentence: string,
  stats: CorpusStats,
): Difficulty {
  const { wordCount, rare, clauses, score } = difficultyParts(sentence, stats);

  const cutoffs = stats.gradeCutoffs;
  if (cutoffs && cutoffs.hard > cutoffs.easy) {
    if (score >= cutoffs.hard) return "hard";
    if (score <= cutoffs.easy) return "easy";
    return "normal";
  }

  if (wordCount >= GRADE_THRESHOLDS.hardWords || rare >= GRADE_THRESHOLDS.hardRare || clauses >= 3 || score >= GRADE_THRESHOLDS.hardScore)
    return "hard";
  if (wordCount <= GRADE_THRESHOLDS.easyWords && rare <= GRADE_THRESHOLDS.easyRare && score <= GRADE_THRESHOLDS.easyScore)
    return "easy";
  return "normal";
}

/**
 * 활용형을 사전형으로 줄인다 (최선 추정: 어미만 잘라낸다).
 * spreads → spread, opened → open, running → run, gardens → garden
 */
/** 규칙으로 줄이기 어려운 불규칙 활용 (힌트 품질용 소규모 표) */
const IRREGULAR_BASE: Record<string, string> = {
  ran: "run", went: "go", stood: "stand", sat: "sit", told: "tell", said: "say",
  had: "have", made: "make", found: "find", thought: "think", came: "come",
  took: "take", knew: "know", wrote: "write", spoke: "speak", wore: "wear",
  drove: "drive", ate: "eat", drank: "drink", sang: "sing", began: "begin",
  swam: "swim", flew: "fly", grew: "grow", threw: "throw", held: "hold",
  left: "leave", felt: "feel", meant: "mean", built: "build", bought: "buy",
  brought: "bring", caught: "catch", taught: "teach", fought: "fight",
  slept: "sleep", kept: "keep", met: "meet", saw: "see", was: "be", were: "be",
};

/**
 * 활용형에서 기본형을 추정한다.
 * vocab(코퍼스 어휘)를 주면 **실제로 사전에 있는 기본형**만 받아들인다.
 * 어휘 정보가 없는 상태에서는 `anything → anyth` 같은 조각을 만들 수 있다.
 */
export function lemma(
  word: string,
  vocab?: Map<string, number> | Set<string>,
): string {
  let w = word.toLowerCase().replace(/[^a-z']/g, "").replace(/'+$/g, "");
  if (!w) return "";
  w = w.replace(/'s$/, "");
  if (!w) return "";

  const trim = (base: string): string =>
    /(.)\1$/.test(base) && base.length > 3 ? base.slice(0, -1) : base;

  // 기본형 후보(먼저) → 표면형(나중)
  const candidates: string[] = [];
  const irregular = IRREGULAR_BASE[w];
  if (irregular) candidates.push(irregular);
  if (w.endsWith("ies") && w.length > 4) candidates.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("ing") && w.length > 5) {
    const stem = trim(w.slice(0, -3));
    candidates.push(stem, `${stem}e`);
  }
  if (w.endsWith("ed") && w.length > 4) {
    const stem = trim(w.slice(0, -2));
    candidates.push(stem, `${stem}e`);
  }
  if (w.endsWith("es") && w.length > 4) candidates.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3 && !/(ss|us|is)$/.test(w)) {
    candidates.push(w.slice(0, -1));
  }

  if (vocab) {
    const has = (c: string) =>
      vocab instanceof Map ? vocab.has(c) : vocab.has(c);
    for (const c of candidates) if (has(c)) return c;
    // 어떤 후보도 코퍼스에 없으면 억지로 줄이지 않고 표면형을 쓴다
    return w;
  }
  return candidates[0] ?? w;
}

export function pickHints(
  sentence: string,
  stats: CorpusStats,
  seed = 0,
): string[] {
  const taken = new Set<string>();
  const ranked: { hint: string; rarity: number; rank: number }[] = [];

  words(sentence).forEach((raw, index) => {
    if (index === 0) return;
    // 문장 두문자가 아닌데 대문자로 시작하면 고유명사로 본다
    if (/^[A-Z]/.test(raw)) return;
    const clean = raw.toLowerCase().replace(/[^a-z']/g, "").replace(/'+$/g, "");
    // 3자 미만·숫자·구두점 파편·축약형(don't, they've)은 힌트로 쓰지 않는다
    if (!/^[a-z][a-z]{2,}$/.test(clean)) return;

    const base = lemma(clean, stats.freq);
    if (base.length < 3) return;
    if (STOPWORDS.has(clean) || STOPWORDS.has(base)) return;
    if (taken.has(base)) return;
    taken.add(base);

    const rarity =
      1 / (1 + (stats.freq.get(clean) ?? 0)) +
      (isCoreWord(base, stats) ? 0 : 0.15);
    ranked.push({ hint: base, rarity, rank: index });
  });

  ranked.sort((a, b) => b.rarity - a.rarity || a.rank - b.rank);
  if (ranked.length === 0) return [];

  // seed는 상위 후보 안에서 순서만 섞는다 (이전 구현의 지터는 seed=0에서 항상 0이었다)
  const window = ranked.slice(0, Math.min(ranked.length, 8));
  if (seed && window.length > 1) {
    const shift = Math.abs(seed) % window.length;
    const rotated = [...window.slice(shift), ...window.slice(0, shift)];
    return rotated.slice(0, 4).map((r) => r.hint);
  }
  return window.slice(0, 4).map((r) => r.hint);
}

/** 코퍼스 항목의 저장소 키 (레인 + 정규화 문장의 짧은 해시)
 *  긴 문장을 그대로 넣으면 120자로 잘려 앞부분이 같은 두 문장이 같은 키가 된다.
 *  그래서 길이 + FNV-1a 해시를 쓴다. (저장소 키이므로 암호학적 해시는 필요 없다) */
export function entryKey(entry: Pick<CorpusEntry, "lane" | "en">): string {
  const normalized = normalizeKey(entry.en);
  return `${entry.lane}:${normalized.length}:${hash36(normalized)}`;
}

/** FNV-1a → 36진 문자열 */
function hash36(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

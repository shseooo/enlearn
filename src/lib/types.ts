export interface LLMSettings {
  host: string;
  model: string;
  apiKey: string;
}

export interface Correction {
  /** 원문 중 틀리거나 불자연스러운 표현 */
  original: string;
  /** 더 좋은 표현 */
  better: string;
  /** 이유 설명 (한국어) */
  reason: string;
}

export interface EvaluationResult {
  /** 0~100 점수 */
  score: number;
  /** 전체적인 평가 (한국어) */
  feedback: string;
  /** 개선할 표현 목록 */
  corrections: Correction[];
  /** 전체 문장을 다듬은 최종 표현 (영어) */
  betterExpression: string;
  /** (번역 연습) 원문 한국어의 자연스러운 영어 참고 번역 */
  referenceTranslation?: string;
}

export type Difficulty = "easy" | "normal" | "hard";

/** 번역 연습용 LLM 생성 결과: 한국어 문장 + 영어 힌트 단어 */
export interface KoreanExercise {
  sentence: string;
  hints: string[];
}

/** 추가 질문 컨텍스트: 사용자의 원문/답안 */
export interface EvaluationContext {
  /** 자유 작성: 사용자가 쓴 영어 문장 / 번역 연습: 한국어 원문 */
  original?: string;
  /** 번역 연습: 사용자의 영어 번역 */
  answer?: string;
}

/** 추가 질문 대화의 한 턴 */
export interface FollowUpTurn {
  question: string;
  answer: string;
}

// ---------------------------------------------------------------------------
// 코퍼스 (실제 출판 문장에서 가져온 연습 문장)
// ---------------------------------------------------------------------------

/** daily = Tatoeba 일상 회화 / classic = 퍼블릭 도메인 동화 원문 */
export type CorpusLane = "daily" | "classic";

export interface CorpusEntry {
  lane: CorpusLane;
  /** 영어 원문 — 학습자가 목표로 삼는 문장 (사람이 쓴 문장) */
  en: string;
  /** 한국어 문장. classic 레인은 빌드 시 비어 있고 앱에서 LLM 번역으로 채운다. */
  ko: string | null;
  /** 영어 힌트 단어 */
  hints: string[];
  difficulty: Difficulty;
  /** 책 제목 등 출처 표시 */
  source: string;
  /** 출처 보충 (Project Gutenberg id, Tatoeba 문장 id 등) */
  sourceId?: string;
}

export interface CorpusSourceInfo {
  id: string;
  title: string;
  author: string;
  count: number;
}

/** public/data/corpus/*.json 파일의 형태 */
export interface CorpusFile {
  lane: CorpusLane;
  generatedAt: string;
  license: string;
  attribution: string;
  sources: CorpusSourceInfo[];
  entries: CorpusEntry[];
}

/**
 * 백업·저장소 합치기가 실제로 무엇을 했는지 (D4-2).
 * 개수 하나만 돌려주면 "400개 합침"이 "400개만 들어가고 1,600건은 버려졌다"와
 * 구분되지 않는다(R6-3).
 *
 * ⚠️ stored는 "받아들여진 개수"다(R7-1). 키가 저장소에 있다는 사실만 세면
 * 병합에서 기존 값(더 최근)이 이겨 아무것도 적용되지 않은 항목까지 합친 것처럼
 * 보이고, 같은 키 중복까지 "상한으로 잘림"으로 보인다. 네 값은 이렇게 나눈다:
 *   stored + merged + trimmed + rejected = 들어온 항목 수 (replace는 merged 0)
 */
export interface ImportResult {
  /** 들어온 값이 실제로 저장소에 반영된 항목 수 */
  stored: number;
  /** sanitizer가 거부한 항목 수 (형식·날짜·길이 규칙 위반) */
  rejected: number;
  /** 저장소 상한(MAX_RECORDS · MAX_SEEN · MAX_SRS · MAX_KOREAN_CACHE)으로 잘린 항목 수 */
  trimmed: number;
  /** 합치기에서 기존 값(더 최근)이 이겨 적용되지 않은 항목 수(D2-1/R7-1) */
  merged: number;
}

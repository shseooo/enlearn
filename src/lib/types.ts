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

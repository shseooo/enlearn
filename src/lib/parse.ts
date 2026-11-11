import type { Correction, EvaluationResult, KoreanExercise } from "./types";

import { extractJson, repairJson } from "./json.ts";

export { extractJson, repairJson };

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** corrections 배열의 각 요소를 정규화한다. (문자열 또는 객체 모두 허용) */
function toCorrection(item: unknown): Correction {
  if (typeof item === "string") {
    return { original: item, better: "", reason: "" };
  }
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, unknown>;
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return "";
    };
    return {
      original: pick("original", "issue", "from", "problem"),
      better: pick("better", "correction", "fix", "suggestion", "to"),
      reason: pick("reason", "explanation", "why", "note"),
    };
  }
  return { original: "", better: "", reason: "" };
}

/**
 * LLM 응답 JSON을 EvaluationResult로 정규화한다.
 * 누락된 필드도 안전하게 채우고, 점수는 0~100으로 클램핑한다.
 */
export function normalizeEvaluation(data: Record<string, unknown>): EvaluationResult {
  const score = Math.max(0, Math.min(100, Math.round(toNumber(data.score))));
  const correctionsRaw = Array.isArray(data.corrections) ? data.corrections : [];
  const result: EvaluationResult = {
    score,
    feedback: typeof data.feedback === "string" ? data.feedback : "",
    corrections: correctionsRaw
      .map(toCorrection)
      .filter((c) => c.original || c.better || c.reason),
    betterExpression:
      typeof data.betterExpression === "string" ? data.betterExpression : "",
  };
  if (typeof data.referenceTranslation === "string" && data.referenceTranslation.trim()) {
    result.referenceTranslation = data.referenceTranslation.trim();
  }
  return result;
}

/** 평문에서 점수처럼 보이는 숫자를 구조 없이 추출한다. (score 85 / 점수: 72 등) */
function salvageScore(text: string): number | null {
  const m = text.match(/(?:score|점수)[^\d]{0,10}(\d{1,3})/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * LLM 응답 문자열을 그대로 EvaluationResult로 파싱한다.
 * 모델이 JSON 지시를 무시하고 평문으로 답한 경우에도 에러 대신
 * 원문을 feedback으로 살려 반환한다. (최선 구조 추출)
 */
export function parseEvaluation(raw: string): EvaluationResult {
  const text = (raw ?? "").trim();
  try {
    return normalizeEvaluation(extractJson(text));
  } catch {
    // JSON이 아닌 평문 응답 → 구조 없이 최대한 살리기
    const salvageable = salvageScore(text);
    // JSON처럼 보였는데 복원까지 실패한 것이라면 raw 덩어리를 화면에 보여주지 않는다
    const looksLikeJson = /^[{[]/.test(text);
    return {
      score: salvageable ?? 0,
      feedback: looksLikeJson
        ? "모델이 형식에 맞는 답변을 만들지 못했습니다. 잠시 후 다시 시도해 보세요."
        : text,
      corrections: [],
      betterExpression: "",
    };
  }
}

const SENTENCE_PREFIXES = /^(?:문장|한국어|한국어 문장|sentence)\s*[:：]\s*/i;

/** hints 배열을 문자열 배열로 정규화한다. (공백 제거, 6개까지) */
function normalizeHints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const t = item.trim();
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.slice(0, 6);
}

/**
 * LLM 응답에서 { sentence, hints }를 추출한다.
 * { sentence } JSON이 아니면 첫 유효 줄을 평문 문장으로, hints는 빈 배열로 폴백한다.
 */
export function parseKoreanExercise(raw: string): KoreanExercise {
  try {
    const data = extractJson(raw);
    if (typeof data.sentence === "string" && data.sentence.trim()) {
      return {
        sentence: data.sentence.trim(),
        hints: normalizeHints(data.hints),
      };
    }
  } catch {
    // JSON이 아니면 아래 평문 폴백으로
  }
  const lines = (raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("{") && !l.startsWith("```"));
  const clean = (l: string) => l.replace(SENTENCE_PREFIXES, "").trim();
  // 라벨만 있는 줄(끝이 콜론)은 건너뛰고, 첫 실제 문장 줄을 사용
  const first =
    lines.map(clean).find((l) => l && !/[:：]$/.test(l)) ??
    (lines[0] ? clean(lines[0]) : undefined);
  if (first) return { sentence: first, hints: [] };
  throw new Error("LLM 응답에서 문장(sentence)을 찾을 수 없습니다.");
}

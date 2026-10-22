import type { Correction, EvaluationResult } from "./types";

/**
 * LLM 응답 텍스트에서 JSON 객체를 추출한다.
 * 코드펜스(```json)와 JSON 앞뒤의 불필요한 설명 텍스트를 방어적으로 제거한다.
 */
export function extractJson(text: string): Record<string, unknown> {
  let t = (text ?? "").trim();

  const fence = t.match(/```(?:json|javascript)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) t = fence[1].trim();

  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("LLM 응답에서 JSON을 찾을 수 없습니다.");
    }
    t = t.slice(start, end + 1);
  }

  try {
    const parsed: unknown = JSON.parse(t);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("LLM 응답을 JSON으로 파싱할 수 없습니다.");
  }
}

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
    // JSON이 아예 없는 평문 응답 → 구조 없이 최대한 살리기
    return {
      score: salvageScore(text) ?? 0,
      feedback: text,
      corrections: [],
      betterExpression: "",
    };
  }
}

const SENTENCE_PREFIXES = /^(?:문장|한국어|한국어 문장|sentence)\s*[:：]\s*/i;

/**
 * LLM 응답 문자열에서 한국어 문장을 추출한다.
 * { sentence } JSON이 아니면 첫 유효 줄을 평문 문장으로 취급한다.
 */
export function parseSentence(raw: string): string {
  try {
    const data = extractJson(raw);
    if (typeof data.sentence === "string" && data.sentence.trim()) {
      return data.sentence.trim();
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
  if (first) return first;
  throw new Error("LLM 응답에서 문장(sentence)을 찾을 수 없습니다.");
}

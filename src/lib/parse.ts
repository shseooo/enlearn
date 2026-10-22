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

/** LLM 응답 문자열을 그대로 EvaluationResult로 파싱한다. */
export function parseEvaluation(raw: string): EvaluationResult {
  return normalizeEvaluation(extractJson(raw));
}

/** LLM 응답 문자열에서 { sentence } 필드를 추출한다. */
export function parseSentence(raw: string): string {
  const data = extractJson(raw);
  if (typeof data.sentence === "string" && data.sentence.trim()) {
    return data.sentence.trim();
  }
  throw new Error("LLM 응답에서 문장(sentence)을 찾을 수 없습니다.");
}

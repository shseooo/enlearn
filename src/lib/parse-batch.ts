/**
 * 코퍼스 빌드 스크립트가 쓰는 배치 번역 응답 파서.
 *
 * src/lib/parse.ts가 아니라 별도 파일인 이유: 빌드 스크립트는 node가 .ts를 직접
 * 실행한다. node는 확장자 없는 import("./parse")를 해석하지 못하므로, 여기서는
 * .ts 확장자를 붙여 import한다.
 */
/**
 * 문장 뭉치 번역 응답을 파싱한다.
 * 프롬프트는 "i: 번호"로 입력하고 {"items":[{"i":1,"ko":"...","hints":[..]}]} 형태로
 * 받도록 되어 있다. 번호가 없으면 원문 정규화 키로 대조하고,
 * 한국어가 아니거나 응급실 수준으로 짧은 항목은 버린다.
 */
export interface BatchTranslation {
  ko: string;
  hints: string[];
}

import { extractJson } from "./json.ts";
import { normalizeKey } from "./corpus-tools.ts";
import { hasHangul } from "../../scripts/lib/foreign-text.ts";

export function parseTranslationBatch(
  raw: string,
  expected: string[],
  /** 폐기한 이유를 빌드 로그에 남기기 위한 콜백 (리뷰 2-1) */
  onReject?: (reason: string) => void,
): Map<string, BatchTranslation> {
  const out = new Map<string, BatchTranslation>();
  let items: unknown[] | null = null;

  const fence = (raw ?? "").match(/```(?:json|javascript)?\s*([\s\S]*?)```/i);
  const body = (fence?.[1] ?? raw ?? "").trim();
  // 모델을 속이는 경우가 많은 "메시지 객체"보다 배열/배열 필드를 먼저 본다
  try {
    if (body.startsWith("[")) items = JSON.parse(body) as unknown[];
  } catch {
    items = null;
  }
  if (!items) {
    try {
      const data = extractJson(body);
      for (const key of ["items", "translations", "results", "data"]) {
        if (Array.isArray(data[key])) {
          items = data[key] as unknown[];
          break;
        }
      }
    } catch {
      items = null;
    }
  }
  if (!items) return out;

  const byKey = new Map<string, string>();
  // 캐시 키와 같은 normalizeKey를 쓴다. 따로 구현을 두면 한 쪽만 어긋나도
  // 번역 캐시가 조용히 전부 미스가 된다(리뷰 3-12).
  expected.forEach((en, index) => byKey.set(normalizeKey(en), String(index)));

  // 식별자(i/en/sentence)가 단 하나도 없는 배열만 "순서대로"로 해석한다.
  const orderedOnly = items.every((item) => {
    if (typeof item !== "object" || item === null) return true;
    const o = item as Record<string, unknown>;
    return (
      o.i === undefined &&
      o.index === undefined &&
      o.n === undefined &&
      typeof o.en !== "string" &&
      typeof o.sentence !== "string"
    );
  });

  /*
   * 번호 기준(1-based / 0-based)은 항목마다 정하지 않고 배치 전체에 대해 한 번 정한다.
   * 항목마다 정하면 0-based 응답에서 첫 항목만 맞고 두 번째 항목부터 한 칸 어긋난
   * 번역이 붙는다. 그 결과는 코퍼스와 번역 캐시에 영구로 남는다(리뷰 2-1).
   */
  const rawIndices: number[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const n = o.i ?? o.index ?? o.n;
    if (typeof n === "number" && Number.isInteger(n)) rawIndices.push(n);
  }
  const hasZero = rawIndices.some((n) => n === 0);
  const outOfZeroBased = rawIndices.some((n) => n >= expected.length);
  // 0이 없으면 기본(1-based). 0이 있고 범위 밖 번호도 있으면 두 기준이 섞였다는 뜻이다.
  // 어느 항목이 어느 기준으로 쓰였는지 알 수 없으므로 번호 대응을 통째로 버린다.
  const numberBase: 0 | 1 | null = hasZero ? (outOfZeroBased ? null : 0) : 1;
  if (numberBase === null) {
    onReject?.(
      `번호 기준이 섞였습니다(0과 ${expected.length} 이상 번호가 함께 옴) — 번호로 대응시키지 않습니다`,
    );
  }

  for (const [position, item] of items.entries()) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const ko = typeof o.ko === "string" ? o.ko.trim() : "";
    // "네." 성의 없는 번역이 코퍼스에 들어가면 화면이 이상해진다. 주석의 약속대로 구두점 빼고 3자 이상(R5-6).
    const compact = ko.replace(/[\s.,!?…"'“”‘’()\[\]·\-]/g, "");
    if (!hasHangul(ko) || compact.length < 3) {
      // 조용히 넘기면 "왜 이 문장은 번역이 없지"를 추적할 수 없다(리뷰 2-1과 같은 이유).
      if (ko) {
        onReject?.(`번역이 너무 짧습니다(구두점 빼고 ${compact.length}자): ${ko.slice(0, 20)}`);
      }
      continue;
    }

    const rawIndex = o.i ?? o.index ?? o.n;
    const hasIndex = typeof rawIndex === "number" && Number.isInteger(rawIndex);
    let index = -1;
    if (hasIndex && numberBase !== null) {
      index = (rawIndex as number) - numberBase;
    }
    if (index < 0 || index >= expected.length) {
      const en =
        typeof o.en === "string" ? o.en : typeof o.sentence === "string" ? o.sentence : "";
      const found = en ? byKey.get(normalizeKey(en)) : undefined;
      // 번호가 어긋났는데 원문 대조까지 실패하면 "자리가 이쯤이니 이 문장"으로
      // 추측하지 않는다. 엉뚱한 번역이 붙으면 코퍼스에 영구로 남는다.
      // 자릿수 대응은 "식별자가 하나도 없는 완전한 목록"일 때만 허용한다(순서 약속).
      if (found !== undefined) {
        index = Number(found);
      } else if (!hasIndex && !en && orderedOnly && items.length === expected.length) {
        index = position;
      } else {
        index = -1;
      }
    }
    if (index < 0 || index >= expected.length) continue;
    if (out.has(expected[index])) continue; // 앞의 항목 우선

    const hints = Array.isArray(o.hints)
      ? (o.hints as unknown[])
          .filter((h): h is string => typeof h === "string" && h.trim().length > 1)
          .map((h) => h.trim())
          .slice(0, 4)
      : [];
    out.set(expected[index], { ko, hints });
  }

  return out;
}

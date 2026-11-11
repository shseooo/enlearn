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

// 한글 자모(3130–318E)와 완성형 음절(AC00–D7A3) 둘 다 본다
const HANGUL = /[\u3130-\u318e]|[\uac00-\ud7a3]/;

/** corpus-tools.normalizeKey와 같은 규칙 (스크립트의 캐시 키와 맞아야 한다) */
function keyOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^a-z0-9\u3130-\ud7ff\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTranslationBatch(
  raw: string,
  expected: string[],
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
  expected.forEach((en, index) => byKey.set(keyOf(en), String(index)));

  for (const [position, item] of items.entries()) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const ko = typeof o.ko === "string" ? o.ko.trim() : "";
    // "네." 성의 없는 번역이 코퍼스에 들어가면 화면이 이상해진다. 구두점 빼고 3자 이상.
    const compact = ko.replace(/[\s.,!?…"'“”‘’()\[\]·\-]/g, "");
    if (!HANGUL.test(ko) || compact.length < 2) continue;

    const rawIndex = o.i ?? o.index ?? o.n;
    const hasIndex = typeof rawIndex === "number" && Number.isInteger(rawIndex);
    let index = -1;
    if (hasIndex) {
      const n = rawIndex as number;
      // 1-based(기본)·0-based 둘 다 받아들인다
      index = n >= 1 && n <= expected.length ? n - 1 : n;
    }
    if (index < 0 || index >= expected.length) {
      const en =
        typeof o.en === "string" ? o.en : typeof o.sentence === "string" ? o.sentence : "";
      const found = en ? byKey.get(keyOf(en)) : undefined;
      // 번호가 어긋났는데 원문 대조까지 실패하면 "자리가 이쯤이니 이 문장"으로
      // 추측하지 않는다. 잘못 붙은 번역은 고치기 어렵다.
      index = found !== undefined ? Number(found) : hasIndex || en ? -1 : position;
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

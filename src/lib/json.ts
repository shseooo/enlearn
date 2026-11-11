/**
 * LLM 응답에서 JSON을 꺼내는 도구. (값 import가 없는 파일 — node가 .ts를 직접
 * 실행하는 빌드 스크립트에서도 쓸 수 있게 유지한다)
 */
/**
 * 부러진 JSON을 복원해 본다. (LLM이 자주 만드는 실수: 후행 쉼, 닫지 않은 괄호)
 * 문자열 안의 내용은 건드리지 않는다.
 */
export function repairJson(text: string): string {
  let s = (text ?? "").trim();
  if (!s) return s;

  // 후행 쉼: { "a": 1, } / [ 1, 2, ]
  s = s.replace(/,(\s*[}\]])/g, "$1");

  // 닫히지 않은 문자열·괄호 메우기
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) s += '"';
  while (stack.length) s += stack.pop();
  return s;
}

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
      // 닫는 괄호조차 없는 잘린 JSON — 여는 괄호부터 복원 시도
      if (start === -1) throw new Error("LLM 응답에서 JSON을 찾을 수 없습니다.");
      t = repairJson(t.slice(start));
    } else {
      t = t.slice(start, end + 1);
    }
  } else if (!t.endsWith("}")) {
    t = repairJson(t);
  }

  const attempt = (value: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const direct = attempt(t);
  if (direct) return direct;

  // 후행 쉼·괄호 불일치 같은 사소한 결함은 복원해 살린다
  const repaired = attempt(repairJson(t));
  if (repaired) return repaired;

  throw new Error("LLM 응답을 JSON으로 파싱할 수 없습니다.");
}

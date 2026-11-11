/**
 * LLM host 입력 검증과 엔드포인트 정규화.
 *
 * src/lib/llm.ts에서 분리한 이유: 설정 화면·백업 화면은 네트워크 코드 없이
 * 이 판단만 필요하고, 테스트에서는 llm을 mock하는데 그 mock에 검증까지
 * 의존하면 안 되기 때문이다. (llm.ts는 같은 이름을 다시 export한다)
 */
/** host 검증 결과. 설정 화면의 인라인 검증에서도 그대로 사용한다. */
export type HostCheck =
  | { ok: true; endpoint: string }
  | { ok: false; message: string };

/**
 * host를 검증해서 /chat/completions 엔드포인트를 만든다.
 * - https://api.openai.com      -> https://api.openai.com/v1/chat/completions
 * - https://api.openai.com/v1   -> https://api.openai.com/v1/chat/completions
 * - http://localhost:11434/v1/  -> http://localhost:11434/v1/chat/completions
 * - .../v1/chat/completions (이미 전체 URL) -> 그대로
 *
 * 스킴이 없는 입력("api.openai.com/v1" 같은 흔한 오타)은 http(s)를 붙여 보정한다.
 * 보정하지 않으면 fetch가 현재 origin 기준 상대 경로로 해석해
 * Authorization(API 키)가 앱 자체 도메인으로 전송된다.
 */
/** 스킴 없는 host 입력의 기본 프로토콜. localhost·포트 명시는 http로 본다. */
function schemeForHostless(raw: string): "http" | "https" {
  const authority = raw.split("/")[0];
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(authority)) return "http";
  if (/^[\w.-]+:\d+$/.test(authority)) return "http";
  return "https";
}

export function checkHost(host: string): HostCheck {
  const raw = host.trim().replace(/\/+$/, "");
  if (!raw) return { ok: false, message: "Host를 입력해주세요." };

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${schemeForHostless(raw)}://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      ok: false,
      message: "Host를 해석할 수 없습니다. 예: https://api.openai.com/v1",
    };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "http(s) 프로토콜만 지원합니다." };
  }
  if (!url.hostname) {
    return { ok: false, message: "Host에 도메인(또는 호스트:포트)이 필요합니다." };
  }

  // origin은 trailing slash를 포함하지 않으므로 경로만 정규화해 붙인다.
  const path = url.pathname.replace(/\/+$/, "");
  const base = `${url.origin}${path}`;
  if (base.endsWith("/chat/completions")) return { ok: true, endpoint: base };
  if (base.endsWith("/v1")) return { ok: true, endpoint: `${base}/chat/completions` };
  return { ok: true, endpoint: `${base}/v1/chat/completions` };
}

/**
 * 저장은 허용하되 경고할 만한 host 설정. (오류 자체는 checkHost가 이미 걸러낸다)
 * 원격 http는 API 키가 평문으로 나가므로 반드시 알려준다.
 */
export function hostWarning(host: string): string | null {
  const check = checkHost(host);
  if (!check.ok || check.endpoint.startsWith("https://")) return null;
  const authority = new URL(check.endpoint).host;
  if (/^(localhost|127\.0\.0\.1|\[::1\])/.test(authority)) return null;
  return "http 호스트입니다. API 키가 평문으로 전송됩니다. https를 지원하는 프로바이더로 바꾸는 것을 권장합니다.";
}

export function buildEndpoint(host: string): string {
  const check = checkHost(host);
  if (!check.ok) throw new Error(check.message);
  return check.endpoint;
}

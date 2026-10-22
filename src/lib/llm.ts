import type { Difficulty, EvaluationResult, LLMSettings } from "./types";
import { parseEvaluation, parseSentence } from "./parse";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/**
 * host를 정규화해서 /chat/completions 엔드포인트를 만든다.
 * - https://api.openai.com      -> https://api.openai.com/v1/chat/completions
 * - https://api.openai.com/v1   -> https://api.openai.com/v1/chat/completions
 * - http://localhost:11434/v1/  -> http://localhost:11434/v1/chat/completions
 * - .../v1/chat/completions (이미 전체 URL) -> 그대로
 */
export function buildEndpoint(host: string): string {
  const base = host.trim().replace(/\/+$/, "");
  if (!base) throw new Error("Host를 입력해주세요.");
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/v1")) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** JSON 응답에서 콘텐츠 문자열을 추출한다. (호환 호스트별 형식 차이 대응) */
function extractContentFromJson(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const c = first as {
    message?: unknown;
    text?: unknown;
    delta?: unknown;
  };
  // 1) 표준: choices[0].message.content (문자열)
  if (
    typeof c.message === "object" &&
    c.message !== null &&
    typeof (c.message as { content?: unknown }).content === "string" &&
    (c.message as { content: string }).content.trim()
  ) {
    return (c.message as { content: string }).content;
  }
  // 2) choices[0].message 자체가 문자열
  if (typeof c.message === "string" && c.message.trim()) return c.message;
  // 3) 스트림 조각: choices[0].delta.content
  if (
    typeof c.delta === "object" &&
    c.delta !== null &&
    typeof (c.delta as { content?: unknown }).content === "string" &&
    (c.delta as { content: string }).content
  ) {
    return (c.delta as { content: string }).content;
  }
  // 4) 레거시 completions 형식: choices[0].text
  if (typeof c.text === "string" && c.text.trim()) return c.text;
  // 5) 추론(reasoning) 모델 폴백: content가 생성되지 않고 (예: finish_reason: "length")
  //    생각 과정만 있는 경우 reasoning_content를 마지막 수단으로 사용
  if (
    typeof c.message === "object" &&
    c.message !== null &&
    typeof (c.message as { reasoning_content?: unknown }).reasoning_content ===
      "string" &&
    (c.message as { reasoning_content: string }).reasoning_content.trim()
  ) {
    return (c.message as { reasoning_content: string }).reasoning_content;
  }
  return null;
}

/** SSE(stream) 응답에서 delta 콘텐츠 조각들을 조합해 추출한다. */
function extractContentFromSse(body: string): string | null {
  let acc = "";
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const data: unknown = JSON.parse(payload);
      const content = extractContentFromJson(data);
      if (content) acc += content;
    } catch {
      // 파싱 안 되는 조각은 건너뜀
    }
  }
  return acc.trim() ? acc : null;
}

/** OpenAI 호환 /chat/completions API를 호출해 응답 본문(content)을 반환한다. */
export async function chatCompletion(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(buildEndpoint(settings.host), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: options.temperature ?? 0.3,
        ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
        stream: false,
      }),
    });
  } catch {
    throw new Error(
      "서버에 연결할 수 없습니다. (네트워크 또는 CORS 문제일 수 있습니다.)",
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 300)}` : "";
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail}`);
  }

  // 본문을 먼저 텍스트로 받아 형식을 직접 판별한다.
  // (res.json()은 SSE/비JSON 본문에서 실패해 원인을 숨기므로)
  const body = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type") ?? "";

  let content: string | null = null;
  if (contentType.includes("event-stream")) {
    // 호스트가 stream: false를 무시하고 SSE 스트림을 반환하는 경우
    content = extractContentFromSse(body);
  } else {
    try {
      content = extractContentFromJson(JSON.parse(body));
    } catch {
      content = null;
    }
    // JSON이 아니거나 구조가 맞지 않으면 SSE로 마지막 시도
    if (content === null) {
      content = extractContentFromSse(body);
    }
  }

  if (!content) {
    const snippet = body.trim().slice(0, 300) || "(빈 응답)";
    throw new Error(
      `LLM 응답에서 콘텐츠(content)를 찾을 수 없습니다. 실제 응답 앞부분: ${snippet}`,
    );
  }
  return content;
}

const JSON_SCHEMA = [
  "{",
  '  "score": 0~100 사이의 숫자 점수,',
  '  "feedback": "전체적인 평가. 한국어로 2~4문장.",',
  '  "corrections": [',
  "    {",
  '      "original": "원문 중 틀리거나 불자연스러운 표현",',
  '      "better": "더 좋은 표현",',
  '      "reason": "그 이유 (한국어)"',
  "    }",
  "  ],",
  '  "betterExpression": "전체 문장을 자연스럽게 다듬은 최종 문장 (영어)"',
  "}",
].join("\n");

const OUTPUT_RULES = [
  "너는 전문 영어 교육 교사다.",
  "사용자의 영어 문장을 꼼꼼히 평가해라.",
  "점수는 문법·어휘·부자연스러움·의사 전달을 종합해 0~100으로 매겨라.",
  "",
  "반드시 다음 JSON 스키마와 정확히 일치하는 JSON 객체 하나만 출력해라.",
  "JSON 이외의 어떤 텍스트, 설명, markdown 코드펜스도 포함하지 마라.",
].join("\n");

function freeWritingSystemPrompt(): string {
  return `${OUTPUT_RULES}\n\nJSON 스키마:\n${JSON_SCHEMA}`;
}

function translationSystemPrompt(): string {
  const schema = JSON_SCHEMA.replace(
    '"betterExpression"',
    '"referenceTranslation": "원문 한국어에 가장 가까운 자연스러운 영어 참고 번역",\n  "betterExpression"',
  );
  return `${OUTPUT_RULES}\n\n원문 한국어와 사용자의 영어 번역을 비교해 평가해라.\n\nJSON 스키마:\n${schema}`;
}

/** 자유 작성: 영어 문장을 평가한다. */
export async function evaluateFreeWriting(
  settings: LLMSettings,
  sentence: string,
): Promise<EvaluationResult> {
  const raw = await chatCompletion(settings, [
    { role: "system", content: freeWritingSystemPrompt() },
    { role: "user", content: `평가할 영어 문장:\n"""${sentence}"""` },
  ]);
  return parseEvaluation(raw);
}

/** 번역 연습: 한국어 원문 + 영어 번역을 평가한다. */
export async function evaluateTranslation(
  settings: LLMSettings,
  korean: string,
  english: string,
): Promise<EvaluationResult> {
  const raw = await chatCompletion(settings, [
    { role: "system", content: translationSystemPrompt() },
    {
      role: "user",
      content: `원문 (한국어):\n"""${korean}"""\n\n사용자의 영어 번역:\n"""${english}"""`,
    },
  ]);
  return parseEvaluation(raw);
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "쉬움 — 현재/과거의 기본 시제, 일상적인 단어",
  normal: "보통 — 과거/미래 시제, 관용적 표현, 동사구 (phrasal verb)",
  hard: "어려움 — 관용구, 복잡한 문장 구조, 비즈니스 표현",
};

/** 번역 연습용 한국어 문장을 생성한다. */
export async function generateKoreanSentence(
  settings: LLMSettings,
  difficulty: Difficulty,
): Promise<string> {
  const raw = await chatCompletion(
    settings,
    [
      {
        role: "system",
        content:
          "영어 학습 앱을 위한 한국어 연습 문장을 만든다. " +
          '반드시 {"sentence": "한국어 문장 한 문장"} 형태의 JSON만 출력해라. ' +
          "JSON 이외의 텍스트는 포함하지 마라.",
      },
      {
        role: "user",
        content: `난이도: ${DIFFICULTY_LABELS[difficulty]}\n문장을 하나 만들어라.`,
      },
    ],
    { temperature: 0.8 },
  );
  return parseSentence(raw);
}

/** 설정 화면의 연결 테스트. 성공하면 LLM 응답 텍스트를 반환한다.
 *  추론(reasoning) 모델도 답까지 생성할 수 있도록 넉넉한 max_tokens를 사용한다. */
export async function testConnection(settings: LLMSettings): Promise<string> {
  const raw = await chatCompletion(
    settings,
    [{ role: "user", content: "연결 테스트입니다. ok만 답해 주세요." }],
    { temperature: 0, maxTokens: 64 },
  );
  return raw.trim();
}

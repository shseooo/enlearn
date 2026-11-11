import type {
  Difficulty,
  EvaluationContext,
  EvaluationResult,
  FollowUpTurn,
  KoreanExercise,
  LLMSettings,
} from "./types";
import { parseEvaluation, parseKoreanExercise } from "./parse";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

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

export function buildEndpoint(host: string): string {
  const check = checkHost(host);
  if (!check.ok) throw new Error(check.message);
  return check.endpoint;
}

/**
 * 프로바이더 본문을 화면에 표시할 수 있게 정리한다.
 * 역프록시·게이트웨이 오류에는 키·토큰이 그대로 실릴 수 있으므로 마스킹하고,
 * 개행은 한 칸으로 줄여 길이 제한 안에 담는다.
 */
export function sanitizeProviderBody(body: string, limit = 300): string {
  const masked = (body ?? "")
    .replace(/(bearer\s+)[^\s"',}]+/gi, "$1[마스킹]")
    .replace(/sk-[A-Za-z0-9_\-]{4,}/g, "sk-[마스킹]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|authorization|secret)["']?\s*[:=]\s*)["']?[^\s"',}]+/gi,
      "$1[마스킹]",
    );
  return masked.replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 추출된 답변. fromReasoning은 "답변 대신 추론 조각만 얻은 경우" */
type ExtractedContent = { text: string; fromReasoning: boolean };

/** JSON 응답에서 콘텐츠 문자열을 추출한다. (호환 호스트별 형식 차이 대응) */
function extractContentFromJson(data: unknown): ExtractedContent | null {
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
    return { text: (c.message as { content: string }).content, fromReasoning: false };
  }
  // 2) choices[0].message 자체가 문자열
  if (typeof c.message === "string" && c.message.trim())
    return { text: c.message, fromReasoning: false };
  // 3) 스트림 조각: choices[0].delta.content
  if (
    typeof c.delta === "object" &&
    c.delta !== null &&
    typeof (c.delta as { content?: unknown }).content === "string" &&
    (c.delta as { content: string }).content
  ) {
    return { text: (c.delta as { content: string }).content, fromReasoning: false };
  }
  // 4) 레거시 completions 형식: choices[0].text
  if (typeof c.text === "string" && c.text.trim())
    return { text: c.text, fromReasoning: false };
  // 5) 추론(reasoning) 모델 폴백: content가 생성되지 않고 (예: finish_reason: "length")
  //    생각 과정만 있는 경우 reasoning_content를 마지막 수단으로 사용
  if (
    typeof c.message === "object" &&
    c.message !== null &&
    typeof (c.message as { reasoning_content?: unknown }).reasoning_content ===
      "string" &&
    (c.message as { reasoning_content: string }).reasoning_content.trim()
  ) {
    return {
      text: (c.message as { reasoning_content: string }).reasoning_content,
      fromReasoning: true,
    };
  }
  return null;
}

/** SSE(stream) 응답에서 delta 콘텐츠 조각들을 조합해 추출한다. */
function extractContentFromSse(body: string): ExtractedContent | null {
  let acc = "";
  let sawAnswer = false;
  let sawReasoning = false;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") break;
    try {
      const data: unknown = JSON.parse(payload);
      const found = extractContentFromJson(data);
      if (!found) continue;
      acc += found.text;
      if (found.fromReasoning) sawReasoning = true;
      else sawAnswer = true;
    } catch {
      // 파싱 안 되는 조각은 건너뜀
    }
  }
  if (!acc.trim()) return null;
  return { text: acc, fromReasoning: !sawAnswer && sawReasoning };
}

/** LLM 호출 옵션 */
export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 취소 버튼 등으로 중단할 때 쓰는 신호 */
  signal?: AbortSignal;
  /** 연결 실패·429·5xx 재시도 횟수 (기본 2) */
  retries?: number;
  /** 재시도 대기 기반 시간(ms). 테스트 등에서 0으로 줄일 수 있다. */
  retryDelayMs?: number;
}

/** 응답 없이 무한정 기다리지 않기 위한 기본 제한 (빌드 스크립트도 같은 방식을 쓴다) */
export const LLM_TIMEOUT_MS = 120_000;

function isAbortError(e: unknown): boolean {
  return (e as Error | undefined)?.name === "AbortError";
}

/** AbortSignal.any가 없는 환경(jsdom 등)에서도 동작하는 신호 합치기 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) controller.abort(s.reason);
    else
      s.addEventListener("abort", () => controller.abort(s.reason), {
        once: true,
      });
  }
  return controller.signal;
}

function cancellationMessage(userSignal?: AbortSignal): string {
  if (userSignal?.aborted) return "요청을 취소했습니다.";
  return (
    `응답이 늦어 요청을 취소했습니다(${Math.round(LLM_TIMEOUT_MS / 1000)}초). ` +
    "호스트·모델 설정이나 서버 상태를 확인하세요."
  );
}

/** 연결 실패(CORS·DNS·오프라인). 잠시 후 다시 시도해 볼 만한 오류 */
class NetworkError extends Error {}

/** HTTP 상태 코드를 보존하는 내부 오류. 사용자에게는 message만 보인다. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    body: string,
    readonly retryAfter: string | null,
    readonly retryable: boolean,
  ) {
    const detail = sanitizeProviderBody(body);
    super(`HTTP ${status} ${statusText}${detail ? `: ${detail}` : ""}`);
    this.name = "HttpError";
  }
}

/** 429/5xx/시간초과처럼 잠시 뒤에 성공할 수 있는 상태 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 800;
const MAX_RETRY_DELAY_MS = 15_000;

/** Retry-After(초 또는 HTTP-date)를 우선하고, 없으면 지수 백오프 */
function retryDelayMs(error: unknown, attempt: number, base: number): number {
  const header = error instanceof HttpError ? error.retryAfter : null;
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, seconds * 1000));
    }
    const when = Date.parse(header);
    if (!Number.isNaN(when)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, when - Date.now()));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, base * 2 ** attempt);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** 요청 한 번. 성공하면 content 문자열, 실패하면 재시도 가능한지 보존한 오류를 던진다. */
async function requestOnce(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatOptions,
  endpoint: string,
  signal: AbortSignal,
): Promise<ExtractedContent> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
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
      signal,
    });
  } catch (e) {
    if (isAbortError(e) || signal.aborted) {
      throw new Error(cancellationMessage(options.signal));
    }
    throw new NetworkError(
      "서버에 연결할 수 없습니다. (네트워크 또는 CORS 문제일 수 있습니다.)",
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(
      res.status,
      res.statusText,
      body,
      res.headers.get("retry-after"),
      isRetryableStatus(res.status),
    );
  }

  // 본문을 먼저 텍스트로 받아 형식을 직접 판별한다.
  // (res.json()은 SSE/비JSON 본문에서 실패해 원인을 숨기므로)
  const body = await res.text().catch(() => "");
  if (!body && signal.aborted)
    throw new Error(cancellationMessage(options.signal));
  const contentType = res.headers.get("content-type") ?? "";

  let content: ExtractedContent | null = null;
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
    const snippet = sanitizeProviderBody(body) || "(빈 응답)";
    throw new Error(
      `LLM 응답에서 콘텐츠(content)를 찾을 수 없습니다. 실제 응답 앞부분: ${snippet}`,
    );
  }
  return content;
}

/**
 * OpenAI 호환 /chat/completions API를 호출해 응답 본문(content)을 반환한다.
 * 연결 실패·429·5xx는 Retry-After를 존중해 최대 options.retries번 다시 시도한다.
 * (400/401 같은 설정 오류는 두 번 돈다 해도 소용이ないので 재시도하지 않는다)
 */
export async function chatCompletion(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<string> {
  return (await chatCompletionDetailed(settings, messages, options)).text;
}

/**
 * chatCompletion과 같지만 답변이 "추론(reasoning) 조각인지"까지 알려준다.
 * 추론만 얻은 경우 그 텍스트를 학습자용 답변처럼 보여주면 안 된다.
 */
export async function chatCompletionDetailed(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatOptions = {},
): Promise<ExtractedContent> {
  const endpoint = buildEndpoint(settings.host);
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const baseDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw new Error("요청을 취소했습니다.");

    const timeoutSignal = AbortSignal.timeout(LLM_TIMEOUT_MS);
    const signal = options.signal
      ? anySignal([options.signal, timeoutSignal])
      : timeoutSignal;

    try {
      return await requestOnce(settings, messages, options, endpoint, signal);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const retryable =
        error instanceof NetworkError ||
        (error instanceof HttpError && error.retryable);
      if (!retryable || attempt === retries || signal.aborted) throw error;
      await sleep(retryDelayMs(error, attempt, baseDelay), signal);
    }
  }
  throw new Error("LLM을 호출할 수 없습니다.");
}

/** 추가 질문 요청에 포함할 최근 턴 수 / 답변 발췌 길이 */
export const FOLLOW_UP_HISTORY_TURNS = 3;
export const FOLLOW_UP_ANSWER_CHARS = 500;

/** 길이를 줄이되 잘린 것을 표시한다. */
function clipText(text: string, limit: number): string {
  const t = (text ?? "").trim();
  if (t.length <= limit) return t;
  return `${t.slice(0, limit)}…(이하 생략)`;
}

/** 호출 종류별 기본 max_tokens — 추론(reasoning) 모델은 "생각"에도 토큰을 쓴다. */
const MAX_TOKENS = {
  evaluation: 1200,
  shortJson: 700,
  followUp: 900,
} as const;

/**
 * 답변 텍스트를 얻는다. 답변 대신 추론 조각만 온 경우는 명확한 오류로 바꾼다.
 * (추론 독백을 피드백·번역처럼 보여주면 학습자가 엉뚱한 글을 읽게 된다)
 */
async function requestAssistantText(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: ChatOptions,
  maxTokens: number,
): Promise<string> {
  const result = await chatCompletionDetailed(settings, messages, {
    ...options,
    maxTokens: options.maxTokens ?? maxTokens,
  });
  if (result.fromReasoning) {
    throw new Error(
      "모델이 답변을 끝내지 못하고 추론만 반환했습니다. " +
        "max_tokens를 늘리거나 호스트에서 reasoning(생각) 길이를 줄여 주세요. " +
        `(추론 앞부분: ${result.text.slice(0, 120)}…)`,
    );
  }
  return result.text;
}

/** 평가 JSON의 공통 필드 정의. 필드 이름은 parse.ts의 별칭 매핑과 짝을 이룬다. */
const EVAL_FIELDS = [
  '  "score": 0~100 사이의 숫자 점수,',
  '  "feedback": "전체적인 평가. 한국어로 2~4문장.",',
  '  "corrections": [',
  "    {",
  '      "original": "원문 중 틀리거나 불자연스러운 표현",',
  '      "better": "더 좋은 표현",',
  '      "reason": "그 이유 (한국어)"',
  "    }",
  "  ],",
];

const FINAL_EXPRESSION_FIELD =
  '  "betterExpression": "전체 문장을 자연스럽게 다듬은 최종 문장 (영어)"';

const SCORE_SCHEMA = ["{", ...EVAL_FIELDS, FINAL_EXPRESSION_FIELD, "}"].join(
  "\n",
);

/** 번역 연습은 참고 원문 영어를 함께 받는다. 스키마를 문자열 치환으로 변형하지 않고 나열한다. */
const TRANSLATION_SCHEMA = [
  "{",
  ...EVAL_FIELDS,
  '  "referenceTranslation": "원문 한국어에 가장 가까운 자연스러운 영어 참고 번역",',
  FINAL_EXPRESSION_FIELD,
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

/** system 프롬프트 조립: 공통 규칙 + 상황별 지시 + JSON 스키마 */
function evaluationSystemPrompt(
  schema: string,
  extraRules: string[] = [],
): string {
  return [OUTPUT_RULES, ...extraRules, "", "JSON 스키마:", schema].join("\n");
}

function freeWritingSystemPrompt(): string {
  return evaluationSystemPrompt(SCORE_SCHEMA, [
    "",
    "사용자가 직접 쓴 영어 문장을 평가해라.",
  ]);
}

function translationSystemPrompt(): string {
  return evaluationSystemPrompt(TRANSLATION_SCHEMA, [
    "",
    "원문 한국어와 사용자의 영어 번역을 비교해 평가해라.",
  ]);
}

/** 자유 작성: 영어 문장을 평가한다. */
export async function evaluateFreeWriting(
  settings: LLMSettings,
  sentence: string,
  options: ChatOptions = {},
): Promise<EvaluationResult> {
  const raw = await requestAssistantText(
    settings,
    [
      { role: "system", content: freeWritingSystemPrompt() },
      { role: "user", content: `평가할 영어 문장:\n"""${sentence}"""` },
    ],
    options,
    MAX_TOKENS.evaluation,
  );
  return parseEvaluation(raw);
}

/** 번역 연습: 한국어 원문 + 영어 번역을 평가한다.
 *  reference를 주면 "실제 출판된 원문"이 있다고 알려주고,
 *  그 문체까지 흉내내도록 요구하지 않는다. (동화 연습에서 점수가 억울해지는 것 방지) */
export async function evaluateTranslation(
  settings: LLMSettings,
  korean: string,
  english: string,
  reference?: string,
  options: ChatOptions = {},
): Promise<EvaluationResult> {
  const ref = reference?.trim() ?? "";
  const userContent = [
    `원문 (한국어):\n"""${korean}"""`,
    `사용자의 영어 번역:\n"""${english}"""`,
  ];
  if (ref) {
    userContent.push(
      `실제 출판된 영어 원문 (참고용):\n"""${ref}"""`,
      "평가 규칙: 사용자의 문장을 위 원문과 똑같이 고치라고 요구하지 마라. " +
        "의사가 정확히 전달되는지, 문법과 어휘가 자연스러운지만 보고점수를 매겨라. " +
        "원문은 더 좋은 예시로만 소개해라.",
    );
  }

  const raw = await requestAssistantText(
    settings,
    [
      { role: "system", content: translationSystemPrompt() },
      { role: "user", content: userContent.join("\n\n") },
    ],
    options,
    MAX_TOKENS.evaluation,
  );
  return parseEvaluation(raw);
}

export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: "쉬움 — 현재/과거의 기본 시제, 일상적인 단어",
  normal: "보통 — 과거/미래 시제, 관용적 표현, 동사구 (phrasal verb)",
  hard: "어려움 — 관용구, 복잡한 문장 구조, 비즈니스 표현",
};

/** 번역 연습용 한국어 문장 + 영어 힌트 단어를 생성한다.
 *  topic을 지정하면 그 주제 관련 문장을 만든다. (미지정은 자유 주제) */
export async function generateKoreanExercise(
  settings: LLMSettings,
  difficulty: Difficulty,
  topic?: string,
  options: ChatOptions = {},
): Promise<KoreanExercise> {
  const trimmedTopic = topic?.trim() ?? "";
  const raw = await requestAssistantText(
    settings,
    [
      {
        role: "system",
        content:
          "영어 학습 앱을 위한 한국어 연습 문장을 만든다. " +
          '반드시 {"sentence": "한국어 문장 한 문장", "hints": ["영어 힌트 단어"]} 형태의 JSON만 출력해라. ' +
          'hints는 사용자가 해당 문장을 영어로 번역하는 데 도움이 되는 핵심 영어 단어/표현 2~4개다. ' +
          "hints는 반드시 영어만 사용하고, 번역 결과를 그대로 드러내지 않도록 주의해라. " +
          "JSON 이외의 텍스트는 포함하지 마라.",
      },
      {
        role: "user",
        content: [
          `난이도: ${DIFFICULTY_LABELS[difficulty]}`,
          trimmedTopic
            ? `주제: ${trimmedTopic}`
            : "주제: 자유 (일상적인 주제 중 적절한 것을 선택)",
          "문장을 하나 만들어라.",
        ].join("\n"),
      },
    ],
    { ...options, temperature: options.temperature ?? 0.8 },
    MAX_TOKENS.shortJson,
  );
  return parseKoreanExercise(raw);
}

/** 코퍼스(동화) 문장을 학습자용 한국어로 번역한다. (창작 금지, 번역만)
 *  요즘 쓰는 자연스러운 한국어로 옮기고, 번역에 필요한 영어 힌트 단어도 함께 받는다. */
export async function translateSentenceToKorean(
  settings: LLMSettings,
  sentence: string,
  options: ChatOptions = {},
): Promise<KoreanExercise> {
  const raw = await requestAssistantText(
    settings,
    [
      {
        role: "system",
        content:
          "영어 문장을 한국어 학습자에게 보여줄 한국어 문장으로만 번역한다. " +
          '반드시 {"sentence": "자연스러운 현대 한국어", "hints": ["핵심 영어 단어"]} 형태의 JSON만 출력해라. ' +
          "sentence는 고어체·문어체가 아니라 오늘 실제로 쓰이는 말투로 옮겨라. " +
          "설명을 더하거나 문장을 창작하지 마라. " +
          "hints는 영어로 2~4개, 그 문장의 핵심 어휘를 골라라. JSON 이외의 텍스트는 금지.",
      },
      { role: "user", content: `영어 문장:\n"""${sentence}"""` },
    ],
    { ...options, temperature: options.temperature ?? 0.3 },
    MAX_TOKENS.shortJson,
  );
  return parseKoreanExercise(raw);
}

/** 설정 화면의 연결 테스트. 성공하면 LLM 응답 텍스트를 반환한다.
 *  추론(reasoning) 모델도 답까지 생성할 수 있도록 넉넉한 max_tokens를 사용한다. */
export async function testConnection(
  settings: LLMSettings,
  options: ChatOptions = {},
): Promise<string> {
  const raw = await chatCompletion(
    settings,
    [{ role: "user", content: "연결 테스트입니다. ok만 답해 주세요." }],
    { ...options, temperature: options.temperature ?? 0, maxTokens: 64 },
  );
  return raw.trim();
}

/**
 * 평가 결과에 대한 추가 질문을 LLM에 던져 답을 받는다.
 * 원문/답안 + 평가 결과 + 이전 질의응답을 컨텍스트로 함께 보낸다.
 * 답변은 순수 텍스트(피드백은 평문으로 충분)로 받는다.
 */
export async function askFollowUp(
  settings: LLMSettings,
  context: EvaluationContext,
  result: EvaluationResult,
  question: string,
  history: FollowUpTurn[] = [],
  options: ChatOptions = {},
): Promise<string> {
  const contextLines: string[] = [];
  if (context.original) contextLines.push(`사용자 원문: """${context.original}"""`);
  if (context.answer) contextLines.push(`사용자의 영어 답안: """${context.answer}"""`);

  const evalJson = JSON.stringify(
    {
      score: result.score,
      feedback: result.feedback,
      corrections: result.corrections,
      betterExpression: result.betterExpression,
      ...(result.referenceTranslation
        ? { referenceTranslation: result.referenceTranslation }
        : {}),
    },
    null,
    2,
  );

  // 화면에는 전체 히스토리를 남기되, 요청에는 최근 턴만 보낸다.
  // (매 턴 답변 전문을 다시 올리면 토큰 비용이 기하급수적으로 늘고 컨텍스트를 넘친다)
  const historyLines = history.slice(-FOLLOW_UP_HISTORY_TURNS).flatMap((h, i) => [
    `질문 ${i + 1}: ${h.question}`,
    `답변 ${i + 1}: ${clipText(h.answer, FOLLOW_UP_ANSWER_CHARS)}`,
  ]);

  const userContent = [
    "평가 컨텍스트:",
    ...contextLines,
    "평가 결과(JSON):",
    evalJson,
    ...(historyLines.length ? ["", "이전 질의응답:", ...historyLines] : []),
    "",
    `새 질문: ${question}`,
  ].join("\n");

  const raw = await requestAssistantText(
    settings,
    [
      {
        role: "system",
        content: [
          "너는 전문 영어 교육 교사다.",
          "아래 평가 컨텍스트에 기반해 사용자의 추가 질문을 한국어로 친절하고 구체적으로 답해라.",
          "문법 설명, 표현의 이유, 더 많은 예문, 학습 팁 등을 요청받을 수 있다.",
          "답변은 읽기 쉽게 작성하고, 영어 예문은 그대로 인용해라.",
        ].join("\n"),
      },
      { role: "user", content: userContent },
    ],
    { ...options, temperature: options.temperature ?? 0.4 },
    MAX_TOKENS.followUp,
  );
  return raw.trim();
}

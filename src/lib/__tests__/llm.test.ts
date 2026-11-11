import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEndpoint,
  askFollowUp,
  checkHost,
  chatCompletion,
  evaluateFreeWriting,
  evaluateTranslation,
  generateKoreanExercise,
  sanitizeProviderBody,
  testConnection,
} from "../llm";
import type { LLMSettings } from "../types";

const settings: LLMSettings = {
  host: "https://api.openai.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function mockFetchOk(
  content: unknown,
  opts: { contentType?: string; body?: string } = {},
) {
  const body = opts.body ?? JSON.stringify(content);
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? (opts.contentType ?? "application/json")
          : null,
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockFetchError(
  status: number,
  opts: { statusText?: string; body?: string; retryAfter?: string } = {},
) {
  return {
    ok: false,
    status,
    statusText: opts.statusText ?? "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null,
    },
    text: async () => opts.body ?? "server busy",
  };
}

function mockOkResponse(content: unknown) {
  const body = JSON.stringify(content);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildEndpoint", () => {
  it("host 끝에 /v1이 없으면 추가한다", () => {
    expect(buildEndpoint("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("trailing slash를 제거한다", () => {
    expect(buildEndpoint("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
  });

  it("이미 전체 엔드포인트면 그대로 사용한다", () => {
    expect(buildEndpoint("https://h.ai/v1/chat/completions")).toBe(
      "https://h.ai/v1/chat/completions",
    );
  });

  it("host가 비어 있으면 에러를 던진다", () => {
    expect(() => buildEndpoint("   ")).toThrow(/Host를 입력해주세요/);
  });

  it("스킴이 빠진 host는 https://로 보정해 항상 절대 URL로 만든다", () => {
    // 스킴 없이는 fetch가 자국 origin 상대 경로로 해석해 API 키가 같이 실려 간다
    expect(buildEndpoint("api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildEndpoint("api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    for (const h of ["api.openai.com", "api.openai.com/v1", "h.ai/v1"]) {
      expect(buildEndpoint(h)).toMatch(/^https?:\/\//);
    }
  });

  it("스킴 없는 localhost·포트 명시는 http로 본다", () => {
    expect(buildEndpoint("localhost:11434")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(buildEndpoint("127.0.0.1:8080/v1")).toBe(
      "http://127.0.0.1:8080/v1/chat/completions",
    );
  });

  it("http(s) 아닌 프로토콜과 해석 불가 host는 거부한다", () => {
    expect(() => buildEndpoint("ftp://x.example/v1")).toThrow(/http\(s\)/);
    expect(() => buildEndpoint("::::")).toThrow(/Host/);
  });

  it("checkHost는 화면에 쓸 메시지와 엔드포인트를 함께 돌려준다", () => {
    expect(checkHost("https://a.ai/v1")).toEqual({
      ok: true,
      endpoint: "https://a.ai/v1/chat/completions",
    });
    expect(checkHost("")).toEqual({
      ok: false,
      message: "Host를 입력해주세요.",
    });
  });
});

describe("chatCompletion", () => {
  it("OpenAI 호환 요청을 보낸다", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "hello" } }] });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("hello");

    const [url, init] = m.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("HTTP 에러면 상태 코드가 포함된 에러를 던진다", async () => {
    const m = vi.fn().mockResolvedValue(
      mockFetchError(401, { statusText: "Unauthorized", body: "invalid api key" }),
    );
    vi.stubGlobal("fetch", m);
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/HTTP 401/);
    // 잘못된 키/모델은 두 번 시도해도 같으므로 재시도하지 않는다
    expect(m).toHaveBeenCalledTimes(1);
  });

  it("네트워크 실패는 재시도하고 결국 연결 오류 메시지를 던진다", async () => {
    const m = vi.fn().mockRejectedValue(new TypeError("fail"));
    vi.stubGlobal("fetch", m);
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }], {
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/연결할 수 없습니다/);
    expect(m).toHaveBeenCalledTimes(3); // 1회 + 재시도 2회
  });

  it("retries: 0이면 재시도하지 않는다", async () => {
    const m = vi.fn().mockRejectedValue(new TypeError("fail"));
    vi.stubGlobal("fetch", m);
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }], {
        retries: 0,
      }),
    ).rejects.toThrow(/연결할 수 없습니다/);
    expect(m).toHaveBeenCalledTimes(1);
  });

  it("429는 Retry-After를 존중해 다시 시도하고, 5xx도 다시 시도한다", async () => {
    const m = vi
      .fn()
      .mockResolvedValueOnce(
        mockFetchError(429, {
          statusText: "Too Many Requests",
          retryAfter: "0",
        }),
      )
      .mockResolvedValueOnce(mockOkResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", m);
    const out = await chatCompletion(settings, [{ role: "user", content: "hi" }], {
      retryDelayMs: 0,
    });
    expect(out).toBe("ok");
    expect(m).toHaveBeenCalledTimes(2);

    const m5 = vi.fn().mockResolvedValue(mockFetchError(503, { statusText: "Busy" }));
    vi.stubGlobal("fetch", m5);
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }], {
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/HTTP 503/);
    expect(m5).toHaveBeenCalledTimes(3);
  });

  it("Retry-After 초 값을 그대로 기다린다", async () => {
    const m = vi
      .fn()
      .mockResolvedValueOnce(mockFetchError(429, { retryAfter: "1" }))
      .mockResolvedValueOnce(mockOkResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", m);
    const started = Date.now();
    await chatCompletion(settings, [{ role: "user", content: "hi" }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(m).toHaveBeenCalledTimes(2);
  });

  it("content가 누락된 응답이면 실제 응답 앞부분이 포함된 에러를 던진다", async () => {
    mockFetchOk({ choices: [] }, { body: '{"foo":1}' });
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/콘텐츠\(content\)를 찾을 수 없습니다/);
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/\{"foo":1\}/);
  });

  it("SSE 스트림(content-type: event-stream) 응답에서 delta를 조합해 반환한다", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"ok"}}]}',
      'data: {"choices":[{"delta":{"content":"!"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    mockFetchOk(null, { body: sseBody, contentType: "text/event-stream" });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("ok!");
  });

  it("content-type이 application/json인데 본문이 SSE여도 폴백으로 파싱한다", async () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"안녕"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    mockFetchOk(null, { body: sseBody });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("안녕");
  });

  it("레거시 choices[0].text 형식도 지원한다", async () => {
    mockFetchOk({ choices: [{ text: "legacy answer" }] });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("legacy answer");
  });

  it("추론 모델: content 없이 reasoning_content만 있으면 그걸 폴백으로 반환한다", async () => {
    // Qwen3 등 추론 모델이 생각 과정에 토큰을 쓰고 finish_reason: length로 종료한 실제 응답
    mockFetchOk({
      id: "chatcmpl-50753373",
      object: "chat.completion",
      created: 1792647769,
      model: "Qwen3-27B",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            reasoning_content:
              "The user is asking for a connection test. I should reply ok.",
          },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 63, completion_tokens: 8 },
    });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toContain("connection test");
  });

  it("content가 있으면 reasoning_content를 무시한다", async () => {
    mockFetchOk({
      choices: [
        {
          message: {
            role: "assistant",
            content: "real answer",
            reasoning_content: "thinking...",
          },
          finish_reason: "stop",
        },
      ],
    });
    const out = await chatCompletion(settings, [
      { role: "user", content: "hi" },
    ]);
    expect(out).toBe("real answer");
  });

  it("빈 본문이면 에러 메시지에 (빈 응답)을 표시한다", async () => {
    mockFetchOk(null, { body: "" });
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/\(빈 응답\)/);
  });

  it("fetch에는 항상 signal이 들어간다 (기본 타임아웃)", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    await chatCompletion(settings, [{ role: "user", content: "hi" }]);
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("API 키가 없으면 Authorization 헤더를 보내지 않는다 (Ollama 등)", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    await chatCompletion(
      { host: "http://localhost:11434/v1", model: "m", apiKey: "" },
      [{ role: "user", content: "hi" }],
    );
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");

    // 키가 있으면 보낸다
    await chatCompletion(settings, [{ role: "user", content: "hi" }]);
    const [, init2] = m.mock.calls[1] as [string, RequestInit];
    expect((init2.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-test",
    );
  });

  it("1,200자가 넘는 평가 응답도 잘리지 않고 파싱된다 (리뷰 1-1)", async () => {
    // 실제 평가 응답 길이(500~1,500자). 성공 본문을 자르면 JSON이 깨진다.
    const content = JSON.stringify({
      score: 82,
      feedback: "문법은 좋지만 시제 하나가 어색해요. " + "보충 설명. ".repeat(120),
      corrections: [
        { original: "goed", better: "went", reason: "불규칙 과거형" + " 입니다.".repeat(50) },
      ],
      betterExpression: "I went to the park yesterday.",
    });
    expect(content.length).toBeGreaterThan(1200);
    mockFetchOk({ choices: [{ message: { content } }] });

    const r = await evaluateFreeWriting(settings, "I goed to the park yesterday.");
    expect(r.score).toBe(82);
    expect(r.corrections).toHaveLength(1);
    expect(r.feedback).toContain("보충 설명.");
  });

  it("번역 연습(참고 원문 포함)도 긴 응답을 그대로 파싱한다", async () => {
    const content = JSON.stringify({
      score: 77,
      feedback: "자연스러워요. " + "자세한 설명이 이어집니다. ".repeat(90),
      corrections: [],
      betterExpression: "I am hungry.",
      referenceTranslation: "I am hungry.",
    });
    const m = mockFetchOk({ choices: [{ message: { content } }] });
    const r = await evaluateTranslation(settings, "배가 고파요.", "I am hungry.");
    expect(r.score).toBe(77);
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(1200);
  });

  it("비정상적으로 큰 성공 본문은 파싱하지 않고 안내한다", async () => {
    mockFetchOk(null, { body: '{"choices":[' + "x".repeat(1_100_000) });
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/비정상적으로 큽니다/);
  });

  it("에러 메시지에 표시하는 프로바이더 본문에서 시크릿을 마스킹한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          mockFetchError(401, {
            statusText: "Unauthorized",
            body: '{"error":"invalid api_key: sk-abcdef123456  Authorization: Bearer zz99"}',
          }),
        ),
    );
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/\[마스킹\]/);
  });

  it("콘텐츠 없음 오류의 응답 앞부분도 마스킹·한 줄 축약한다", async () => {
    mockFetchOk(null, {
      body: '{"debug": "Bearer supersecrettoken"}\nsecond line',
    });
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/Bearer \[마스킹\]/);
  });

  it("sanitizeProviderBody는 개행을 줄이고 길이로 자른다", () => {
    expect(sanitizeProviderBody("a\nb\tc")).toBe("a b c");
    expect(sanitizeProviderBody("aaaaaa", 3)).toBe("aaa");
  });

  it("사용자가 취소하면 취소 메시지를 던진다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("The user aborted a request.", "AbortError")),
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = chatCompletion(settings, [{ role: "user", content: "hi" }], {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/요청을 취소했습니다/);
  });
});

describe("evaluateFreeWriting", () => {
  it("코드펜스가 포함된 LLM 응답도 평가 결과로 파싱한다", async () => {
    const content =
      "```json\n" +
      JSON.stringify({
        score: 85,
        feedback: "잘했어요.",
        corrections: [
          { original: "goed", better: "went", reason: "과거형" },
        ],
        betterExpression: "I went to the park.",
      }) +
      "\n```";
    mockFetchOk({ choices: [{ message: { content } }] });

    const r = await evaluateFreeWriting(settings, "I goed to the park.");
    expect(r.score).toBe(85);
    expect(r.corrections[0].better).toBe("went");
    expect(r.betterExpression).toBe("I went to the park.");
  });
  it("평가 요청에는 max_tokens를 보내 추론에 예산을 다 쓰지 않게 한다", async () => {
    const m = mockFetchOk({
      choices: [{ message: { content: '{"score": 70, "feedback": "좋아요."}' } }],
    });
    await evaluateFreeWriting(settings, "I goed to the park.");
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(1200);
  });

  it("평가 프롬프트는 스키마를 공유하되 번역 연습만 referenceTranslation을 요구한다", async () => {
    const m = mockFetchOk({
      choices: [{ message: { content: '{"score": 70, "feedback": "좋아요."}' } }],
    });
    await evaluateFreeWriting(settings, "I goed home.");
    await evaluateTranslation(settings, "배가 고파요.", "I am hungry.");

    const systemPromptOf = (call: unknown[]): string => {
      const body = JSON.parse((call[1] as RequestInit).body as string);
      return (body.messages as { role: string; content: string }[])[0].content;
    };

    const free = systemPromptOf(m.mock.calls[0]);
    const translation = systemPromptOf(m.mock.calls[1]);

    expect(free).toContain('"score"');
    expect(free).toContain('"corrections"');
    expect(free).not.toContain("referenceTranslation");
    expect(translation).toContain('"referenceTranslation"');
    expect(translation).toContain('"corrections"');
    // 두 프롬프트가 같은 출력 규칙을 공유한다
    for (const p of [free, translation]) {
      expect(p).toContain("JSON 이외의 어떤 텍스트");
    }
  });

  it("답변 대신 추론만 돌아오면 그 독백을 피드백처럼 보여주지 않고 안내한다", async () => {
    mockFetchOk({
      choices: [
        {
          message: {
            role: "assistant",
            reasoning_content:
              "Let me think about this sentence. The user wrote 'goed'...",
          },
          finish_reason: "length",
        },
      ],
    });
    await expect(
      evaluateFreeWriting(settings, "I goed to the park."),
    ).rejects.toThrow(/추론만 반환|답변을 끝내지/);
  });
});

describe("generateKoreanExercise", () => {
  it("sentence와 hints를 함께 반환한다", async () => {
    mockFetchOk({
      choices: [
        {
          message: {
            content:
              '{"sentence": "여행을 좋아합니다.", "hints": ["like", "travel"]}',
          },
        },
      ],
    });
    const r = await generateKoreanExercise(settings, "normal");
    expect(r).toEqual({ sentence: "여행을 좋아합니다.", hints: ["like", "travel"] });
  });

  it("hints가 없는 응답도 빈 배열로 처리한다", async () => {
    mockFetchOk({
      choices: [{ message: { content: '{"sentence": "어제 공원에 갔다."}' } }],
    });
    const r = await generateKoreanExercise(settings, "normal");
    expect(r.hints).toEqual([]);
  });

  it("문장 생성 요청에도 max_tokens를 보낸다", async () => {
    const m = mockFetchOk({
      choices: [
        { message: { content: '{"sentence": "배가 고파요.", "hints": ["hungry"]}' } },
      ],
    });
    await generateKoreanExercise(settings, "easy");
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).max_tokens).toBe(700);
  });

  it("주제를 지정하면 요청 본문에 주제 정보가 포함된다", async () => {
    const m = mockFetchOk({
      choices: [
        { message: { content: '{"sentence": "여행은 좋았습니다."}' } },
      ],
    });
    await generateKoreanExercise(settings, "easy", "여행");
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find(
      (msg: { role: string }) => msg.role === "user",
    ) as { content: string };
    expect(userMsg.content).toContain("주제: 여행");
  });

  it("주제를 지정하지 않으면 자유 주제로 요청한다", async () => {
    const m = mockFetchOk({
      choices: [{ message: { content: '{"sentence": "오늘 밥을 먹었어요."}' } }],
    });
    await generateKoreanExercise(settings, "normal", "");
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find(
      (msg: { role: string }) => msg.role === "user",
    ) as { content: string };
    expect(userMsg.content).toContain("자유");
  });
});

describe("testConnection", () => {
  it("LLM 응답을 반환한다", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const reply = await testConnection(settings);
    expect(reply).toBe("ok");
  });

  it("추론 모델이 답까지 만들 수 있도록 넉넉한 max_tokens(64)를 보낸다", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    await testConnection(settings);
    const [, init] = m.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(64);
  });
});

describe("askFollowUp", () => {
  const result = {
    score: 70,
    feedback: "전반적으로 좋아요.",
    corrections: [{ original: "goed", better: "went", reason: "과거형" }],
    betterExpression: "I went to the park.",
  };

  function getUserContent(fetchMock: ReturnType<typeof vi.fn>): string {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const userMsg = body.messages.find(
      (msg: { role: string }) => msg.role === "user",
    ) as { content: string };
    return userMsg.content;
  }

  it("원문과 평가 결과를 컨텍스트로 포함해 요청한다", async () => {
    const m = mockFetchOk({
      choices: [{ message: { content: "went는 과거형이에요." } }],
    });
    const reply = await askFollowUp(
      settings,
      { original: "I goed to the park.", answer: "I goed." },
      result,
      "왜 went인가요?",
    );
    expect(reply).toBe("went는 과거형이에요.");
    const content = getUserContent(m);
    expect(content).toContain("I goed to the park.");
    expect(content).toContain("I goed.");
    expect(content).toContain("왜 went인가요?");
    expect(content).toContain("went"); // 평가 결과 반영
  });

  it("이전 질의응답이 있으면 히스토리로 포함한다", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "답변" } }] });
    await askFollowUp(
      settings,
      { original: "I goed." },
      result,
      "새 질문",
      [{ question: "첫 질문", answer: "첫 답변" }],
    );
    const content = getUserContent(m);
    expect(content).toContain("첫 질문");
    expect(content).toContain("첫 답변");
  });

  it("LLM 응답을 잘라서 반환한다", async () => {
    mockFetchOk({ choices: [{ message: { content: "  답변 본문  " } }] });
    const reply = await askFollowUp(
      settings,
      { original: "x" },
      result,
      "q",
    );
    expect(reply).toBe("답변 본문");
  });

  it("히스토리는 최근 3턴만 컨텍스트에 넣는다 (비용·컨텍스트 폭증 방지)", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "답" } }] });
    await askFollowUp(
      settings,
      { original: "x" },
      result,
      "새 질문",
      [1, 2, 3, 4, 5].map((n) => ({
        question: `질문${n}`,
        answer: `답변${n}`,
      })),
    );
    const content = getUserContent(m);
    expect(content).toContain("질문3");
    expect(content).toContain("질문5");
    expect(content).not.toContain("질문1");
    expect(content).not.toContain("질문2");
  });

  it("긴 답변은 잘라서 보내고 새 질문은 그대로 보낸다", async () => {
    const m = mockFetchOk({ choices: [{ message: { content: "답" } }] });
    await askFollowUp(
      settings,
      { original: "x" },
      result,
      "새 질문",
      [{ question: "질문1", answer: "가".repeat(600) }],
    );
    const content = getUserContent(m);
    expect(content).toContain("이하 생략");
    expect(content).not.toContain("가".repeat(600));
    expect(content).toContain("새 질문");
  });
});

describe("sanitizeProviderBody —키·토큰 마스킹 (리뷰 3-10)", () => {
  it("Azure식 hex 키와 JWT, Cookie 헤더를 가린다", () => {
    const raw =
      'Authentication failed. key=ab12cd34ef56ab12cd34ef56ab12cd34 ' +
      'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF123_456 ' +
      "Set-Cookie: session=supersecretvalue; Path=/";
    const out = sanitizeProviderBody(raw);
    expect(out).toContain("[키마스킹]");
    expect(out).toContain("[토큰마스킹]");
    expect(out).not.toContain("ab12cd34ef56");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("supersecretvalue");
  });

  it("평범한 오류 메시지는 그대로 둔다", () => {
    expect(sanitizeProviderBody("Rate limit exceeded")).toBe(
      "Rate limit exceeded",
    );
  });
});

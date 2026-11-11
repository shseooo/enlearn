import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEndpoint,
  askFollowUp,
  checkHost,
  chatCompletion,
  evaluateFreeWriting,
  generateKoreanExercise,
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid api key",
      }),
    );
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("네트워크 실패면 연결 오류 메시지를 던진다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fail")));
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/연결할 수 없습니다/);
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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEndpoint,
  chatCompletion,
  evaluateFreeWriting,
  generateKoreanSentence,
  testConnection,
} from "../llm";
import type { LLMSettings } from "../types";

const settings: LLMSettings = {
  host: "https://api.openai.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function mockFetchOk(content: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => content,
    text: async () => JSON.stringify(content),
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

  it("content가 누락된 응답이면 에러를 던진다", async () => {
    mockFetchOk({ choices: [] });
    await expect(
      chatCompletion(settings, [{ role: "user", content: "hi" }]),
    ).rejects.toThrow(/choices\[0\].message.content/);
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

describe("generateKoreanSentence", () => {
  it("sentence 필드를 반환한다", async () => {
    mockFetchOk({
      choices: [{ message: { content: '{"sentence": "어제 공원에 갔다."}' } }],
    });
    const s = await generateKoreanSentence(settings, "normal");
    expect(s).toBe("어제 공원에 갔다.");
  });
});

describe("testConnection", () => {
  it("LLM 응답을 반환한다", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const reply = await testConnection(settings);
    expect(reply).toBe("ok");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  balanceByDifficulty,
  requestChatOnce,
  retryableStatus,
} from "../build-corpus.mts";
import type { CorpusEntry } from "../../src/lib/types.ts";

function entry(difficulty: CorpusEntry["difficulty"], n: number): CorpusEntry {
  return {
    lane: "classic",
    en: `Sentence number ${n}.`,
    ko: null,
    hints: [],
    difficulty,
    source: "테스트",
  };
}

function pool(counts: { easy: number; normal: number; hard: number }): CorpusEntry[] {
  const out: CorpusEntry[] = [];
  let n = 0;
  for (const [difficulty, count] of Object.entries(counts) as [
    CorpusEntry["difficulty"],
    number,
  ][]) {
    for (let i = 0; i < count; i++) out.push(entry(difficulty, n++));
  }
  return out;
}

describe("빌드 스크립트 순수 함수 (리뷰 3-7)", () => {
  it("재시도할 수 있는 상태만 재시도 대상으로 본다", () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(retryableStatus(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(retryableStatus(status)).toBe(false);
    }
  });

  it("401은 재시도 대상이 아니고 원문을 안내 문구로 알려준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", { status: 401, statusText: "Unauthorized" }),
      ),
    );
    const attempt = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(attempt.ok).toBe(false);
    expect(attempt.retryable).toBe(false);
    expect(attempt.message).toMatch(/401/);
    expect(attempt.message).toMatch(/API 키/);
    vi.unstubAllGlobals();
  });

  it("429는 Retry-After를 밀리초로 옮겨준다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "2" },
        }),
      ),
    );
    const attempt = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(attempt.retryable).toBe(true);
    expect(attempt.retryAfterMs).toBe(2000);
    vi.unstubAllGlobals();
  });

  it("연결 실패·빈 응답은 재시도 대상으로 분류한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    const network = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(network.retryable).toBe(true);
    expect(network.message).toMatch(/fetch failed/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "  " } }] }), { status: 200 })),
    );
    const empty = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(empty.ok).toBe(false);
    expect(empty.retryable).toBe(true);
    vi.unstubAllGlobals();
  });

  it("스크립트를 import해도 빌드가 실행되지 않는다", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await import("../build-corpus.mts");
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("난이도 배분", () => {
  const source = pool({ easy: 752, normal: 930, hard: 725 });

  it("비율대로 자르고 개수를 넘기지 않는다", () => {
    const picked = balanceByDifficulty(source, 100, 7);
    const count = (d: CorpusEntry["difficulty"]) =>
      picked.filter((e) => e.difficulty === d).length;
    expect(picked).toHaveLength(100);
    // RATIO = easy 0.3 / normal 0.45 / hard 0.25
    expect(count("easy")).toBe(30);
    expect(count("normal")).toBe(45);
    expect(count("hard")).toBe(25);
  });

  it("한 난이도 풀이 비면 나머지로 채운다", () => {
    const scarce = pool({ easy: 5, normal: 50, hard: 50 });
    const picked = balanceByDifficulty(scarce, 60, 3);
    expect(picked).toHaveLength(60);
    expect(picked.filter((e) => e.difficulty === "easy")).toHaveLength(5);
  });

  it("같은 seed는 같은 선택을 만든다 (재현 가능한 빌드)", () => {
    const a = balanceByDifficulty(source, 200, 11).map((e) => e.en);
    const b = balanceByDifficulty(source, 200, 11).map((e) => e.en);
    expect(a).toEqual(b);
  });

  it("전체가 cap 이하면 그대로 돌려준다", () => {
    const small = pool({ easy: 2, normal: 2, hard: 2 });
    expect(balanceByDifficulty(small, 100, 1)).toHaveLength(6);
  });
});

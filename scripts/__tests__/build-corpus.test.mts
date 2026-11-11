import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  balanceByDifficulty,
  requestChatOnce,
  shouldFlushTranslationCache,
  TRANSLATION_CACHE_FLUSH_BATCHES,
  TRANSLATION_CACHE_FLUSH_MS,
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
  it("409도 재시도 대상으로 본다 — 브라우저 쪽과 같은 규칙 (리뷰 2-12)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("conflict", { status: 409, statusText: "Conflict" })),
    );
    const attempt = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(attempt.retryable).toBe(true);
    vi.unstubAllGlobals();
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

  it("채운 항목에 중복이 없다 — 남은 풀 채우기는 Set으로 판정한다 (리뷰 2-10)", () => {
    const picked = balanceByDifficulty(source, 300, 5);
    expect(picked).toHaveLength(300);
    expect(new Set(picked).size).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// 번역 캐시 쓰기 묶기 (리뷰 2-10)
// ---------------------------------------------------------------------------

describe("shouldFlushTranslationCache", () => {
  it("배치마다 캐시 전체를 다시 쓰지 않고 N배치 또는 시간 경과 때만 쓴다", () => {
    expect(shouldFlushTranslationCache(1, 0)).toBe(false);
    expect(
      shouldFlushTranslationCache(TRANSLATION_CACHE_FLUSH_BATCHES - 1, TRANSLATION_CACHE_FLUSH_MS - 1),
    ).toBe(false);
    expect(shouldFlushTranslationCache(TRANSLATION_CACHE_FLUSH_BATCHES, 0)).toBe(true);
    expect(shouldFlushTranslationCache(1, TRANSLATION_CACHE_FLUSH_MS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 직접 실행할 때의 실패 안내 (리뷰 2-6)
// ---------------------------------------------------------------------------

describe("빌드 진입점 — 실패를 안내로 끝낸다 (리뷰 2-6)", () => {
  const REPO = process.cwd();

  function build(args: string[], cwd: string): { status: number | null; out: string } {
    const r = spawnSync(process.execPath, [join(REPO, "scripts", "build-corpus.mts"), ...args], {
      cwd,
      encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  it("원본이 없는 --offline 실행은 스택 트레이스 없이 안내하고 exit 1", () => {
    const root = mkdtempSync(join(tmpdir(), "enlearn-corpus-cli-"));
    try {
      const r = build(["--offline", "--lane=daily"], root);
      expect(r.status).toBe(1);
      expect(r.out).toContain("빌드 실패: 캐시에 없음(--offline): kor-eng.zip");
      expect(r.out).toContain("--offline 으로 다시 실행하세요");
      // 줄 번호·Node 배너는 사용자에게 다음 조치가 아니다
      expect(r.out).not.toMatch(/^\s+at /m);
      expect(r.out).not.toContain("Node.js v");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

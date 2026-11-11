import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  MIN_RETAIN_RATIO,
  balanceByDifficulty,
  chatEndpoint,
  describeWriteProblem,
  fetchBytes,
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

// ---------------------------------------------------------------------------
// 코퍼스 파일 덮어쓰기 안전망 (리뷰 3-1)
// ---------------------------------------------------------------------------

describe("describeWriteProblem — 쓰기 직전의 안전망", () => {
  const FILE = "/tmp/classics.json";

  it("수록 0개는 --force로도 쓰지 않는다", () => {
    expect(describeWriteProblem("classic", FILE, 0, 1400, false)).toMatch(/수록 문장 0개/);
    expect(describeWriteProblem("classic", FILE, 0, null, true)).toMatch(/수록 문장 0개/);
  });

  it("이전 대비 급감은 거부하고, --force로만 넘긴다", () => {
    expect(describeWriteProblem("classic", FILE, 25, 1400, false)).toMatch(/급감/);
    expect(describeWriteProblem("classic", FILE, 25, 1400, true)).toBeNull();
  });

  it("새 파일이거나 상한 이상이면 쓴다", () => {
    expect(describeWriteProblem("classic", FILE, 1, null, false)).toBeNull();
    expect(
      describeWriteProblem(
        "classic",
        FILE,
        Math.ceil(1400 * MIN_RETAIN_RATIO),
        1400,
        false,
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 내려받기 재시도 — 영구 실패(404/403)는 LLM 쪽과 같이 재시도하지 않는다 (리뷰 3-11)
// ---------------------------------------------------------------------------

describe("fetchBytes", () => {
  it("404는 한 번만 시도하고 다음 URL로 넘어간다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("", { status: 404, statusText: "Not Found" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBytes("https://gutenberg.example/pg11.txt")).rejects.toThrow(
      /내려받기 실패: HTTP 404/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("503은 세 번 시도하되, 마지막 실패 뒤에는 기다리지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () =>
        new Response("", { status: 503, statusText: "Service Unavailable" }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const attempt = fetchBytes("https://gutenberg.example/pg11.txt");
      const assertion = expect(attempt).rejects.toThrow(/내려받기 실패: HTTP 503/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 엔드포인트 정규화는 설정 화면과 같은 checkHost를 쓴다 (리뷰 3-12)
// ---------------------------------------------------------------------------

describe("chatEndpoint", () => {
  it("host → /chat/completions 정규화가 화면 쪽과 같은 결과를 준다", () => {
    expect(chatEndpoint("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(chatEndpoint("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(chatEndpoint("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    // 스킴 없는 입력은 fetch가 상대 경로로 해석하지 않게 보정한다
    expect(chatEndpoint("api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
  });

  it("host가 깨지면 빌드 안내 문구로 실패한다", () => {
    expect(() => chatEndpoint("")).toThrow(/ENLEARN_LLM_HOST/);
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

  /** 사람 손으로 옮긴 한국어가 들어 있는 코퍼스 파일 하나를 만든다. */
  function seedHumanCorpus(root: string, count: number): string {
    mkdirSync(join(root, "public", "data", "corpus"), { recursive: true });
    const path = join(root, "public", "data", "corpus", "classics.json");
    const entries = Array.from({ length: count }, (_, i) => ({
      lane: "classic",
      en: `Committed sentence number ${i}.`,
      ko: `사람이 옮긴 문장 ${i}번입니다.`,
      hints: [],
      difficulty: "normal",
      source: "이상한 나라의 앨리스",
      sourceId: "alice",
    }));
    writeFileSync(
      path,
      JSON.stringify({
        lane: "classic",
        generatedAt: "2026-01-01T00:00:00.000Z",
        license: "public domain",
        attribution: "테스트",
        sources: [],
        entries,
      }),
    );
    return path;
  }

  it("원본을 하나도 받지 못한 빌드는 기존 classics.json을 덮지 않고 exit 1 (리뷰 3-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "enlearn-corpus-empty-"));
    try {
      const path = seedHumanCorpus(root, 1);
      const before = readFileSync(path, "utf8");

      const r = build(["--lane=classic", "--offline"], root);
      expect(r.status).toBe(1);
      expect(r.out).toContain("수록 문장 0개");
      expect(r.out).toContain("빌드를 멈춥니다");
      expect(r.out).not.toContain("코퍼스 빌드 완료");
      // 1,400문장이 들어 있는 유일한 추적 사본은 그대로다
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("수록이 급감하면 쓰지 않고, --force일 때만 쓴다 — 일부 책 실패는 exit 1로 남긴다 (리뷰 3-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "enlearn-corpus-drop-"));
    try {
      // 한 권의 원본만 캐시에 있다 → 25문장만 수록된다.
      mkdirSync(join(root, ".corpus-cache"), { recursive: true });
      const sentences = Array.from(
        { length: 25 },
        (_, i) =>
          `The alice number ${i} walked slowly down the long hall and looked at the garden.`,
      );
      writeFileSync(
        join(root, ".corpus-cache", "pg11.txt"),
        [
          "*** START OF THE PROJECT GUTENBERG EBOOK ALICE ***",
          ...sentences,
          "*** END OF THE PROJECT GUTENBERG EBOOK ALICE ***",
        ].join("\n"),
      );
      const path = seedHumanCorpus(root, 100);
      const before = readFileSync(path, "utf8");

      const refused = build(["--lane=classic", "--offline"], root);
      expect(refused.status).toBe(1);
      expect(refused.out).toContain("급감했습니다");
      expect(refused.out).toContain("--force");
      expect(readFileSync(path, "utf8")).toBe(before);

      const forced = build(["--lane=classic", "--offline", "--force"], root);
      expect(JSON.parse(readFileSync(path, "utf8")).entries).toHaveLength(25);
      // 내려받기가 일부 실패한 빌드는 "성공"으로 끝나지 않는다
      expect(forced.status).toBe(1);
      expect(forced.out).toContain("내려받지 못한 책 13권");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

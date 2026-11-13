import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  MIN_RETAIN_RATIO,
  balanceByDifficulty,
  chatEndpoint,
  describeWriteProblem,
  fetchBytes,
  readExistingEntries,
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
// 오류 응답 본문을 소비한다 — 안 읽으면 연결이 "사용 중"으로 남는다 (리뷰 4-6)
// ---------------------------------------------------------------------------

describe("오류 응답 본문 처리 (리뷰 4-6)", () => {
  /** undici처럼 보이는 응답: 본문 취소 여부를 센다. */
  function errorResponse(status: number, statusText: string) {
    const cancel = vi.fn(async () => {});
    return {
      ok: false,
      status,
      statusText,
      headers: new Headers(),
      body: { cancel },
    };
  }

  it("fetchBytes는 실패 응답의 본문을 취소한다", async () => {
    const response = errorResponse(404, "Not Found");
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBytes("https://gutenberg.example/pg11.txt")).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 본문을 읽지 않고 버리면 그 연결이 사용 중으로 남는다
    expect(response.body.cancel).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("requestChatOnce도 브라우저 쪽과 같이 실패 본문을 소비한다", async () => {
    const response = errorResponse(401, "Unauthorized");
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const attempt = await requestChatOnce("https://h/v1/chat/completions", {}, {});
    expect(attempt.ok).toBe(false);
    expect(attempt.retryable).toBe(false);
    expect(response.body.cancel).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// 원본 캐시 완전성 — 잘린 원본을 "완성본"으로 재사용하지 않는다 (리뷰 4-1)
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

  /*
   * D6-1: seed로 후보 전체를 섞어 자르면 후보가 몇 개 빠져도 수록분이 통째로
   * 바뀐다(실측: 잡음 8건 제거에 383문장 교체). 이전 수록분을 먼저 고르면
   * 실제로 바뀐 문장은 그 몇 개뿐이고, 사람 손으로 옮긴 ko도 그대로 남는다.
   */
  it("이전에 실린 문장을 먼저 고르고, 후보 하나를 빼면 한 문장만 바뀐다 (D6-1)", () => {
    const first = balanceByDifficulty(source, 100, 7);
    const removed = first[0];
    const second = balanceByDifficulty(
      source.filter((e) => e !== removed),
      100,
      7,
      { easy: 0.3, normal: 0.45, hard: 0.25 },
      first,
    );

    const before = new Set(first.map((e) => e.en));
    const after = new Set(second.map((e) => e.en));
    const gone = [...before].filter((en) => !after.has(en));
    const added = [...after].filter((en) => !before.has(en));
    expect(second).toHaveLength(100);
    // 빠지는 것은 후보에서 지운 그 한 문장, 채우는 것은 새 후보 한 문장이다.
    expect(gone).toEqual([removed.en]);
    expect(added).toHaveLength(1);
    expect(source.some((e) => e.en === added[0])).toBe(true);
  });

  it("필터가 거부한 옛 문장만큼 새 문장이 들어오고 나머지는 그대로다 (D6-1)", () => {
    const first = balanceByDifficulty(source, 100, 7);
    // 잡음 8건이 새 필터에 걸려 후보에서 빠진 상황
    const noise = new Set(first.slice(0, 8).map((e) => e.en));
    const next = balanceByDifficulty(
      source.filter((e) => !noise.has(e.en)),
      100,
      7,
      { easy: 0.3, normal: 0.45, hard: 0.25 },
      first,
    );
    const kept = next.filter((e) => !noise.has(e.en));
    expect(next).toHaveLength(100);
    expect(kept).toHaveLength(100);
    // 이전 수록분 92건은 그대로, 새 문장은 8건만 들어온다.
    expect(next.filter((e) => first.some((p) => p.en === e.en))).toHaveLength(92);
    expect(next.filter((e) => !first.some((p) => p.en === e.en))).toHaveLength(8);
  });

  it("이전 사본을 그대로 쓰므로 사람 번역(ko)이 남고, 새 문장은 ko가 비어 있다 (D6-1)", () => {
    const translated: CorpusEntry[] = source
      .filter((e) => e.difficulty === "hard")
      .slice(0, 60)
      .map((e, i) => ({ ...e, ko: `사람이 옮긴 번역 ${i}번.` }));

    const picked = balanceByDifficulty(
      source,
      100,
      9,
      { easy: 0.3, normal: 0.45, hard: 0.25 },
      translated,
    );
    expect(picked).toHaveLength(100);
    expect(picked.filter((e) => e.ko).length).toBe(60);
    expect(picked.filter((e) => !e.ko).length).toBe(40);
  });

  // 이전 파일 순서를 그대로 두면 git diff에 "빠진 문장 / 들어온 문장"만 보인다.
  it("이전 파일 순서를 유지하고 새 문장은 뒤에 붙인다 (D6-1)", () => {
    const first = balanceByDifficulty(source, 100, 7);
    const noise = new Set(first.slice(0, 3).map((e) => e.en));
    const next = balanceByDifficulty(
      source.filter((e) => !noise.has(e.en)),
      100,
      7,
      { easy: 0.3, normal: 0.45, hard: 0.25 },
      first,
    );
    // 유지한 문장은 이전 파일 순서 그대로 앞에 있고,
    // 빈자리를 채운 새 문장만 뒤에 붙는다.
    const carried = first.filter((e) => !noise.has(e.en));
    expect(next.slice(0, carried.length).map((e) => e.en)).toEqual(
      carried.map((e) => e.en),
    );
    expect(next.slice(carried.length)).toHaveLength(3);
    expect(
      next.slice(carried.length).every((e) => !first.some((p) => p.en === e.en)),
    ).toBe(true);
  });

  it("난이도 비율은 빈자리를 채울 때 맞춘다 (D6-1)", () => {
    const previous = source.filter((e) => e.difficulty === "hard").slice(0, 20);
    const picked = balanceByDifficulty(
      source,
      100,
      4,
      { easy: 0.3, normal: 0.45, hard: 0.25 },
      previous,
    );
    const count = (d: CorpusEntry["difficulty"]) =>
      picked.filter((e) => e.difficulty === d).length;
    expect(picked).toHaveLength(100);
    // 이미 들어온 hard 20건을 유지하고, 비율(25)까지 5건만 채운다.
    expect(count("hard")).toBe(25);
    expect(count("normal")).toBe(45);
    expect(count("easy")).toBe(30);
  });
});

/*
 * D6-1: 안정 선택은 "지금까지 무엇이 실렸는지"를 읽는 데서 시작한다.
 * 읽기에 실패하면(파일 없음·깨짐) 안정 선택 없이 예전처럼 고르면 된다.
 */
describe("readExistingEntries (D6-1)", () => {
  it("없으면 null, entries 배열이면 그대로, 깨진 파일은 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "enlearn-corpus-"));
    try {
      expect(readExistingEntries(join(dir, "nope.json"))).toBeNull();

      writeFileSync(
        join(dir, "ok.json"),
        JSON.stringify({ entries: [entry("easy", 1)] }),
      );
      expect(readExistingEntries(join(dir, "ok.json"))?.map((e) => e.en)).toEqual([
        "Sentence number 1.",
      ]);

      writeFileSync(join(dir, "broken.json"), '{ "entries": [ 잘림');
      expect(readExistingEntries(join(dir, "broken.json"))).toBeNull();

      writeFileSync(join(dir, "noentries.json"), JSON.stringify({ lane: "classic" }));
      expect(readExistingEntries(join(dir, "noentries.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  /** Gutenberg 형식의 원본 캐시 파일 하나를 만든다. withEndMarker=false는 쓰는 도중 죽은 복사다. */
  function seedBookCache(root: string, id: number, count: number, withEndMarker: boolean, label = "alice"): void {
    mkdirSync(join(root, ".corpus-cache"), { recursive: true });
    const lines = Array.from(
      { length: count },
      (_, i) =>
        `The ${label} number ${i} walked slowly down the long hall and looked at the garden.`,
    );
    writeFileSync(
      join(root, ".corpus-cache", `pg${id}.txt`),
      [
        `*** START OF THE PROJECT GUTENBERG EBOOK ${id} ***`,
        ...lines,
        ...(withEndMarker ? [`*** END OF THE PROJECT GUTENBERG EBOOK ${id} ***`] : []),
      ].join("\n"),
    );
  }

  it("잘린 원본 캐시는 완성본으로 쓰지 않는다 — 다시 내려받으라고 하고 그 책의 문장을 싣지 않는다 (리뷰 4-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "enlearn-corpus-truncated-"));
    try {
      seedBookCache(root, 11, 60, false, "alice"); // 쓰는 도중 죽은 캐시: 꼬리 마커 없음
      seedBookCache(root, 12, 60, true, "mirror"); // 정상 캐시
      const path = seedHumanCorpus(root, 40);
      const before = readFileSync(path, "utf8");

      const r = build(["--lane=classic", "--offline"], root);
      expect(r.status).toBe(1);
      expect(r.out).toContain("완성본이 아닙니다");
      expect(r.out).toContain("내려받지 못한 책 13권");

      const written = JSON.parse(readFileSync(path, "utf8")) as { entries: { en: string }[] };
      // 앞부분만 남은 원본이 다음 빌드에 조용히 참여하면 안 된다
      expect(written.entries.length).toBeGreaterThan(0);
      expect(written.entries.every((e) => !e.en.includes("The alice number"))).toBe(true);
      expect(before).toContain("사람이 옮긴 문장");
      // tmp 잔여물이 코퍼스 자리에 남지 않는다
      expect(
        readdirSync(join(root, "public", "data", "corpus")).filter((n) => n.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--offline에서 잘린 캐시는 안내로 끝난다 (리뷰 4-1)", () => {
    const root = mkdtempSync(join(tmpdir(), "enlearn-corpus-truncated-offline-"));
    try {
      seedBookCache(root, 11, 60, false);
      const path = seedHumanCorpus(root, 40);
      const before = readFileSync(path, "utf8");

      const r = build(["--lane=classic", "--offline"], root);
      expect(r.status).toBe(1);
      expect(r.out).toContain("캐시가 불완전합니다(--offline): pg11.txt");
      expect(r.out).not.toMatch(/^\s+at /m);
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

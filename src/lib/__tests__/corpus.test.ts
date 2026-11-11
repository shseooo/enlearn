import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_KOREAN_CACHE,
  MAX_SEEN,
  cacheKorean,
  clearCorpusCache,
  clearKoreanCache,
  dailySeed,
  getCachedCorpus,
  getCachedKorean,
  getProgressServerSnapshot,
  getProgressSnapshot,
  importKoreanCache,
  importSeen,
  isSeen,
  koreanCacheCount,
  loadCorpus,
  loadSeen,
  localDateString,
  markSeen,
  pickEntry,
  prefillCorpus,
  resetSeen,
  resolveKorean,
  seenCount,
  sourcesOf,
} from "../corpus";
import { entryKey } from "../corpus-tools";
import type { CorpusEntry, CorpusFile } from "../types";

function entry(overrides: Partial<CorpusEntry>): CorpusEntry {
  return {
    lane: "daily",
    en: "The cat sat on the mat.",
    ko: "고양이 매트 위에 앉아 있다.",
    hints: ["cat"],
    difficulty: "easy",
    source: "Tatoeba",
    sourceId: "1",
    ...overrides,
  };
}

function file(entries: CorpusEntry[]): CorpusFile {
  return {
    lane: "daily",
    generatedAt: "2026-01-01T00:00:00.000Z",
    license: "CC-BY 2.0 (France)",
    attribution: "Tatoeba",
    sources: [],
    entries,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  clearCorpusCache();
  vi.restoreAllMocks();
});

describe("일일 시드", () => {
  it("localDateString는 UTC가 아니라 로력 날짜를 쓴다", () => {
    // 로컬 23:30 — UTC로 환산하면 다음 날인 시간대가 많다 (KST는 09:00에 하루가 바뀐다)
    expect(localDateString(new Date(2026, 0, 1, 23, 30))).toBe("2026-01-01");
    expect(dailySeed("daily", new Date(2026, 0, 1, 23, 30))).toBe(
      dailySeed("daily", new Date(2026, 0, 1, 0, 5)),
    );
  });

  it("로컬 자정을 넘기면 시드가 바뀐다", () => {
    expect(dailySeed("daily", new Date(2026, 0, 1, 23, 59))).not.toBe(
      dailySeed("daily", new Date(2026, 0, 2, 0, 1)),
    );
  });

  it("레인이 다르면 다른 순서가 된다", () => {
    const d = new Date(2026, 0, 1, 12);
    expect(dailySeed("daily", d)).not.toBe(dailySeed("classic", d));
  });
});

describe("코퍼스 로딩", () => {
  it("prefill하면 네트워크 없이 읽어온다", async () => {
    prefillCorpus("daily", file([entry({})]));
    const loaded = await loadCorpus("daily");
    expect(loaded.entries).toHaveLength(1);
    expect(getCachedCorpus("daily")).toBe(loaded);
  });

  it("파일이 없으면 빌드 안내를 담은 오류를 낸다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    await expect(loadCorpus("classic")).rejects.toThrow(/npm run corpus/);
    vi.unstubAllGlobals();
  });

  it("필수 필드가 깨진 코퍼스는 조용히 폴백하지 않고 에러를 던진다", async () => {
    // lane/난이도/힌트가 없는 항목을 통과시키면 난이도 필터가 아무것도
    // 매칭하지 못해 재출제 폴백으로 조용히 빠진다.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          lane: "daily",
          generatedAt: "x",
          sources: [],
          entries: [{ en: "I am hungry.", ko: null, source: "Tatoeba" }],
        }),
      }),
    );
    await expect(loadCorpus("daily")).rejects.toThrow(/형식이 올바르지/);
    vi.unstubAllGlobals();
  });

  it("항목이 영어 문장이 아니면 형식 오류를 낸다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ lane: "daily", entries: [{ ko: "만 있음" }] }),
      }),
    );
    await expect(loadCorpus("daily")).rejects.toThrow(/형식/);
    vi.unstubAllGlobals();
  });
});

describe("문장 고르기", () => {
  const pool = file([
    entry({ en: "Easy one goes here.", difficulty: "easy", sourceId: "a" }),
    entry({ en: "Normal one comes along later.", difficulty: "normal", sourceId: "a" }),
    entry({ en: "Hard sentence with rarer words today.", difficulty: "hard", sourceId: "b" }),
  ]);

  it("난이도에 맞는 문장만 후보로 삼는다", () => {
    const picked = pickEntry(pool, { difficulty: "hard", seed: 1 });
    expect(picked?.recycled).toBe(false);
    expect(picked?.entry.difficulty).toBe("hard");
  });

  it("출처(sourceId)로 좁힐 수 있다", () => {
    const picked = pickEntry(pool, { difficulty: "easy", sourceId: "a", seed: 3 });
    expect(picked?.entry.sourceId).toBe("a");
    expect(picked?.entry.difficulty).toBe("easy");
    expect(picked?.recycled).toBe(false);
  });

  it("그 출처에 난이도가 없으면 난이도를 지키고 출처를 완화한다", () => {
    const picked = pickEntry(pool, {
      difficulty: "easy",
      sourceId: "b",
      seed: 3,
    });
    // b에는 쉬운 문장이 없다 → 다른 책의 쉬운 문장(안 푼 것)을 고른다
    expect(picked?.entry.difficulty).toBe("easy");
    expect(picked?.entry.sourceId).toBe("a");
    // 안 푼 문장이므로 "재출제"가 아니다
    expect(picked?.recycled).toBe(false);
  });

  it("푼 문장은 다음 번 후보에서 빠진다", () => {
    const first = pickEntry(pool, { difficulty: "easy", seed: 5 });
    expect(first?.entry.en).toBe("Easy one goes here.");
    markSeen(entryKey(first!.entry));
    expect(isSeen(entryKey(first!.entry))).toBe(true);

    // 쉬운 문장이 다 소진되면 난이도를 완화해 안 푼 문장을 고른다 (재출제 아님)
    const second = pickEntry(pool, { difficulty: "easy", seed: 5 });
    expect(second?.entry.difficulty).not.toBe("easy");
    expect(second?.recycled).toBe(false);
  });

  it("다 풀면 이미 푼 문장을 재출제하고 recycled를 true로 알려준다", () => {
    for (const e of pool.entries) markSeen(entryKey(e));
    const picked = pickEntry(pool, { difficulty: "easy", seed: 2 });
    expect(picked?.entry.difficulty).toBe("easy");
    expect(picked?.recycled).toBe(true);
  });

  it("includeSeen이면 푼 문장도 후보에 넣는다", () => {
    markSeen(entryKey(pool.entries[0]));
    const picked = pickEntry(pool, {
      difficulty: "easy",
      includeSeen: true,
      seed: 4,
    });
    expect(picked?.entry.difficulty).toBe("easy");
    expect(picked?.recycled).toBe(true);
  });

  it("코퍼스가 비어 있으면 null을 돌려준다", () => {
    expect(pickEntry(file([]), { difficulty: "easy" })).toBeNull();
  });
});

describe("푼 기록", () => {
  it("개수를 세고 레인별로 지울 수 있다", () => {
    markSeen("daily:alpha");
    markSeen("classic:beta");
    expect(seenCount()).toBe(2);
    expect(seenCount("daily")).toBe(1);

    resetSeen("daily");
    expect(loadSeen()).toEqual({ "classic:beta": expect.any(String) });
    resetSeen();
    expect(seenCount()).toBe(0);
  });

  it("깨진 값이 들어 있어도 기본값으로 동작한다", () => {
    window.localStorage.setItem("enlearn.seen.v2", "{깨진 json");
    expect(seenCount()).toBe(0);
    markSeen("daily:x");
    expect(isSeen("daily:x")).toBe(true);
  });
});

describe("동화 문장의 한국어 캐시", () => {
  it("힌트가 문자열 배열이 아니면 캐시를 무시한다", () => {
    window.localStorage.setItem(
      "enlearn.kocache.v2",
      JSON.stringify({ k: { ko: "문장.", hints: [1, 2] } }),
    );
    expect(getCachedKorean("k")).toBeNull();
  });

  it("번역 캐시 개수를 세고 레인별로 지울 수 있다", () => {
    cacheKorean("classic:alice", "안녕.", ["hello"]);
    cacheKorean("classic:oz", "잘 가.", ["bye"]);
    cacheKorean("daily:x", "그래?", ["really"]);
    expect(koreanCacheCount()).toBe(3);
    expect(koreanCacheCount("classic")).toBe(2);

    clearKoreanCache("classic");
    expect(koreanCacheCount("classic")).toBe(0);
    expect(koreanCacheCount("daily")).toBe(1);

    clearKoreanCache();
    expect(koreanCacheCount()).toBe(0);
  });

  it("백업으로 들어온 번역 캐시도 cacheKorean과 같은 규칙으로 줄인다 (리뷰 1-16)", () => {
    const accepted = importKoreanCache({
      "classic:1:long": {
        ko: "가".repeat(3000),
        hints: Array.from({ length: 20 }, (_, i) => `힌트${i}`.repeat(30)),
      },
      "classic:2:mixed": { ko: "정상 번역입니다.", hints: ["ok", 42, null] },
      "classic:3:empty": { ko: "   ", hints: ["x"] },
      "classic:4:notobj": "번역 문자열",
    });
    expect(accepted).toBe(2);

    const long = getCachedKorean("classic:1:long")!;
    expect(long.ko.length).toBe(600);
    expect(long.hints).toHaveLength(6);
    expect(long.hints.every((h) => h.length <= 40)).toBe(true);

    expect(getCachedKorean("classic:2:mixed")!.hints).toEqual(["ok"]);
    expect(getCachedKorean("classic:3:empty")).toBeNull();
    expect(getCachedKorean("classic:4:notobj")).toBeNull();
  });

  it("코퍼스에 한국어가 있으면 그대로, 없으면 캐시를 쓴다", () => {
    const withKo = entry({ ko: "이미 있는 한국어." });
    expect(resolveKorean(withKo)).toBe("이미 있는 한국어.");

    const classic = entry({ lane: "classic", ko: null });
    expect(resolveKorean(classic)).toBeNull();

    const key = entryKey(classic);
    cacheKorean(key, "고양이가 매트 위에 앉아 있어요.", ["cat", "mat"]);
    expect(getCachedKorean(key)?.hints).toEqual(["cat", "mat"]);
    expect(resolveKorean(classic)).toBe("고양이가 매트 위에 앉아 있어요.");
  });
});

describe("진행 상황 스냅샷 (설정 화면)", () => {
  it("값이 바뀌기 전에는 같은 참조를 돌려준다", () => {
    const first = getProgressSnapshot();
    expect(getProgressSnapshot()).toBe(first);

    markSeen("daily:x");
    const second = getProgressSnapshot();
    expect(second).not.toBe(first);
    expect(second.daily).toBe(1);
  });

  it("서버 스냅샷은 항상 같은 0 값", () => {
    expect(getProgressServerSnapshot()).toBe(getProgressServerSnapshot());
    expect(getProgressServerSnapshot()).toEqual({ daily: 0, classic: 0, korean: 0 });
  });
});

describe("책 목록", () => {
  it("출처별로 개수를 센다", () => {
    const list = sourcesOf(
      file([
        entry({ sourceId: "alice", source: "이상한 나라의 앨리스" }),
        entry({ sourceId: "alice", source: "이상한 나라의 앨리스", en: "Another one here." }),
        entry({ sourceId: "oz", source: "오즈의 마법사", en: "Third distinct sentence." }),
      ]),
    );
    expect(list).toEqual([
      { id: "alice", title: "이상한 나라의 앨리스", count: 2 },
      { id: "oz", title: "오즈의 마법사", count: 1 },
    ]);
  });
});

describe("코퍼스 요청 취소·타임아웃 (리뷰 3-2)", () => {
  const responseOf = (file: unknown) =>
    new Response(JSON.stringify(file), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("취소한 호출만 실패하고 같은 파일을 기다리던 다른 호출은 성공한다", async () => {
    clearCorpusCache();
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    vi.stubGlobal("fetch", vi.fn(() => promise));

    const body = file([entry({ en: "Tom looks very sick." })]);
    const controller = new AbortController();
    const cancelled = loadCorpus("daily", controller.signal);
    const survivor = loadCorpus("daily");

    controller.abort();
    await expect(cancelled).rejects.toThrow(/취소/);
    resolve(responseOf(body));
    const loaded = await survivor;
    expect(loaded.entries).toHaveLength(1);
    // 취소가 캐시를 망가뜨리지 않았다
    expect(getCachedCorpus("daily")?.entries).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("이미 취소된 신호로는 요청을 시작하지 않는다", async () => {
    clearCorpusCache();
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const controller = new AbortController();
    controller.abort();
    await expect(loadCorpus("daily", controller.signal)).rejects.toThrow(/취소/);
    expect(spy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("저장소 상한·실패 처리 (리뷰 3-9)", () => {
  it("번역 캐시 값 길이를 줄이고, 상한에서 오래된 것부터 버린다", () => {
    cacheKorean("classic:1:long", "가".repeat(2000), Array.from({ length: 12 }, (_, i) => `힌트${i}가`.repeat(20)));
    const cached = getCachedKorean("classic:1:long")!;
    expect(cached.ko.length).toBe(600);
    expect(cached.hints).toHaveLength(6);
    expect(cached.hints[0].length).toBeLessThanOrEqual(40);

    // 상한까지 채우는 경로는 한 번의 벌크 쓰기로 만든다. 4,050번의 개별 쓰기는
    // O(n²)이라 기본 testTimeout에 걸려 스위트가 간헐적으로 실패했다(리뷰 1-7).
    const bulk: Record<string, { ko: string; hints: string[] }> = {};
    for (let i = 0; i < MAX_KOREAN_CACHE + 50; i++) {
      bulk[`classic:${i}:fill`] = { ko: `채움 번역 ${i}번입니다.`, hints: ["fill"] };
    }
    expect(importKoreanCache(bulk, true)).toBeLessThanOrEqual(MAX_KOREAN_CACHE);
    expect(koreanCacheCount()).toBe(MAX_KOREAN_CACHE);
    // 가장 나중에 들어온 항목은 살아있다
    expect(getCachedKorean(`classic:${MAX_KOREAN_CACHE + 49}:fill`)).not.toBeNull();
    expect(getCachedKorean("classic:0:fill")).toBeNull();
  });

  it("상한까지 채운 뒤 한 건을 더 추가해도 개수를 넘지 않는다 (증분 경로)", () => {
    const bulk: Record<string, { ko: string; hints: string[] }> = {};
    for (let i = 0; i < MAX_KOREAN_CACHE; i++) {
      bulk[`classic:${i}:fill`] = { ko: `채움 번역 ${i}번입니다.`, hints: ["fill"] };
    }
    importKoreanCache(bulk, true);

    cacheKorean("classic:extra:fill", "마지막에 추가한 번역.", ["extra"]);
    expect(koreanCacheCount()).toBe(MAX_KOREAN_CACHE);
    expect(getCachedKorean("classic:extra:fill")).not.toBeNull();
    expect(getCachedKorean("classic:0:fill")).toBeNull();
  });

  it("푼 문장 기록도 상한을 넘지 않는다", () => {
    const bulk: Record<string, string> = {};
    for (let i = 0; i < MAX_SEEN + 10; i++) {
      bulk[`daily:${i}:k`] = `2026-01-0${(i % 5) + 1}T00:00:00.000Z`;
    }
    const accepted = importSeen(bulk, true);
    expect(accepted).toBeLessThanOrEqual(MAX_SEEN);
    expect(seenCount()).toBe(MAX_SEEN);
  });

  it("저장이 실패하면 다음 읽기도 저장소의 이전 값을 본다 (파싱 캐시)", () => {
    markSeen("daily:1:kept");
    const before = window.localStorage.getItem("enlearn.seen.v2");

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    markSeen("daily:2:phantom");
    spy.mockRestore();

    // 메모리에 파싱 결과를 재사용해도, 실패한 변경이 화면에 보이지 않아야 한다
    expect(window.localStorage.getItem("enlearn.seen.v2")).toBe(before);
    expect(isSeen("daily:2:phantom")).toBe(false);
    expect(seenCount()).toBe(1);
  });

  it("저장이 실패하면 가져온 개수는 0이고 이전 기록이 그대로 남는다", () => {
    prefillCorpus("daily", file([entry({ en: "Stored before failure.", sourceId: "77" })]));
    markSeen(entryKey({ lane: "daily", en: "Stored before failure.", sourceId: "77" } as CorpusEntry));
    const before = seenCount();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    expect(
      importSeen({ "daily:9:zz": "2026-03-01T00:00:00.000Z" }, false),
    ).toBe(0);
    expect(() => markSeen("daily:10:yy")).not.toThrow();
    vi.spyOn(Storage.prototype, "setItem").mockRestore();

    expect(seenCount()).toBe(before);
    expect(isSeen("daily:9:zz")).toBe(false);
  });
});

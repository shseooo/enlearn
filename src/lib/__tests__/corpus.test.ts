import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_KOREAN_CACHE,
  MAX_SEEN,
  cacheKorean,
  clearCorpusCache,
  clearKoreanCache,
  clearLegacyStorageKeys,
  exportKoreanCache,
  dailySeed,
  getCachedCorpus,
  getCachedKorean,
  getProgressServerSnapshot,
  getProgressSnapshot,
  importKoreanCache,
  importSeen,
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

  // 리뷰 4-9: 대부분의 화면·스토어 테스트는 prefillCorpus로 검증을 우회한다.
  // 실제로 파일 한 장을 통과시키는 경로와, 필드별로 거부하는 기준을 여기서 고정한다.
  const validRawEntry = () => ({
    lane: "daily",
    en: "I am hungry.",
    ko: null,
    hints: ["hungry"],
    difficulty: "easy",
    source: "Tatoeba",
    sourceId: "1",
  });

  /** 항목을 하나 넣고 loadCorpus를 돌려, 통과하면 entries를 / 거부는 오류 문장을 돌려준다. */
  async function loadWith(entryValue: unknown): Promise<{ ok: boolean; message: string }> {
    clearCorpusCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          lane: "daily",
          generatedAt: "x",
          license: "CC-BY",
          attribution: "Tatoeba",
          sources: [],
          entries: [entryValue],
        }),
      }),
    );
    try {
      const loaded = await loadCorpus("daily");
      return { ok: true, message: loaded.entries.map((e) => e.en).join(",") };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("파일 자체가 형식 밖이면 거부한다 — entries 배열·객체 검사 (리뷰 4-9)", async () => {
    for (const bad of [null, [], "문자열", { lane: "daily" }, { lane: "daily", entries: {} }]) {
      const result = await loadWithFile(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(result.message).toMatch(/형식이 올바르지/);
    }
  });

  /** 파일 전체를 그대로 넣어 loadCorpus를 돌린다. */
  async function loadWithFile(value: unknown): Promise<{ ok: boolean; message: string }> {
    clearCorpusCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => value }));
    try {
      await loadCorpus("daily");
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("완전히 올바른 파일은 통과한다 (리뷰 4-9)", async () => {
    const result = await loadWith(validRawEntry());
    expect(result.ok).toBe(true);
    expect(result.message).toBe("I am hungry.");
  });

  it("ko·sourceId 키가 아예 없는 항목도 통과한다 — null과 같은 취급 (리뷰 4-5)", async () => {
    // 두 필드는 "값이 null일 수 있다"는 뜻이지 "키가 있어야 한다"는 뜻이 아니다.
    // 키 누락을 거부하면 손으로 고친 코퍼스 파일 전체가 "형식이 올바르지 않습니다"가 된다.
    const withoutKeys = validRawEntry();
    delete (withoutKeys as Record<string, unknown>).ko;
    delete (withoutKeys as Record<string, unknown>).sourceId;
    expect((await loadWith(withoutKeys)).ok).toBe(true);

    // ko가 빠진 classic 항목은 화면에서 번역 캐시로 이어진다
    clearCorpusCache();
    const loaded = await (async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ lane: "classic", entries: [withoutKeys] }),
        }),
      );
      try {
        return await loadCorpus("classic");
      } finally {
        vi.unstubAllGlobals();
      }
    })();
    expect(resolveKorean(loaded.entries[0])).toBeNull();
  });

  it("필드별로 잘못된 항목은 표로 거부한다 (리뷰 4-9)", async () => {
    const rejects: [string, Record<string, unknown>][] = [
      ["en이 빈 문자열", { en: "   " }],
      ["en이 문자열 아님", { en: 42 }],
      ["ko가 문자열도 null도 아님", { ko: 42 }],
      ["sourceId가 문자열도 null도 아님", { sourceId: 7 }],
      ["source가 문자열 아님", { source: null }],
      ["lane이 모르는 레인", { lane: "classicx" }],
      ["lane이 없음", { lane: undefined }],
      ["difficulty 오탈자", { difficulty: "ez" }],
      ["hints가 배열 아님", { hints: "hungry" }],
      ["hints에 빈 문자열", { hints: [""] }],
      ["hints에 문자열 아닌 값", { hints: [42] }],
    ];
    for (const [label, override] of rejects) {
      const result = await loadWith({ ...validRawEntry(), ...override });
      expect(result.ok, label).toBe(false);
      expect(result.message, label).toMatch(/형식이 올바르지/);
    }
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
    expect(entryKey(first!.entry) in loadSeen()).toBe(true);

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

  // 리뷰 4-9: 재출제 폴백의 순위 5(난이도 완화)와 7(둘 다 완화)가 0회였다.
  // 어떤 순서로 완화하는지가 고정이 아니면, 재출제가 엉뚱한 출처/난이도로 빠져도 모른다.
  it("다 푼 상태에서 순위 5(난이도 유지)가 순위 6(출처 유지)보다 앞선다 (리뷰 4-9)", () => {
    const exhausted = file([
      entry({ en: "Exhausted easy from a.", difficulty: "easy", sourceId: "a" }),
      entry({ en: "Exhausted normal from a too.", difficulty: "normal", sourceId: "a" }),
      entry({ en: "Exhausted hard from b only.", difficulty: "hard", sourceId: "b" }),
    ]);
    for (const e of exhausted.entries) markSeen(entryKey(e));

    // 쉬운 문장(a)과 같은 출처의 어려운 문장(b)이 경쟁하면, 난이도를 지키러 a로 간다.
    const picked = pickEntry(exhausted, { difficulty: "easy", sourceId: "b", seed: 2 });
    expect(picked?.entry.en).toBe("Exhausted easy from a.");
    expect(picked?.recycled).toBe(true);
  });

  it("난이도가 없으면 출처를 지키고, 둘 다 없으면 마지막 순위로 간다 (리뷰 4-9)", () => {
    const only = file([
      entry({ en: "Only easy from a here.", difficulty: "easy", sourceId: "a" }),
      entry({ en: "Only hard from c here too.", difficulty: "hard", sourceId: "c" }),
    ]);
    for (const e of only.entries) markSeen(entryKey(e));

    // 같은 난이도 후보가 없다 → 출처 a를 지킨다 (순위 6)
    const bySource = pickEntry(only, { difficulty: "normal", sourceId: "a", seed: 1 });
    expect(bySource?.entry.en).toBe("Only easy from a here.");

    // 난이도도 출처도 아무 것과 맞지 않는다 → 순위 7
    const lastResort = pickEntry(only, { difficulty: "normal", sourceId: "zzz", seed: 1 });
    expect(lastResort?.recycled).toBe(true);
    expect(["Only easy from a here.", "Only hard from c here too."]).toContain(
      lastResort?.entry.en,
    );
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
    window.localStorage.setItem("enlearn.seen.v3", "{깨진 json");
    expect(seenCount()).toBe(0);
    markSeen("daily:x");
    expect("daily:x" in loadSeen()).toBe(true);
  });
});

describe("동화 문장의 한국어 캐시", () => {
  it("힌트가 문자열 배열이 아니면 캐시를 무시한다", () => {
    window.localStorage.setItem(
      "enlearn.kocache.v3",
      JSON.stringify({ k: { ko: "문장.", hints: [1, 2] } }),
    );
    expect(getCachedKorean("k")).toBeNull();
  });

  // 리뷰 2-15: 내보내기(백업)가 저장소 값에 검증된 타입만 붙이고 있었다.
  // 그러면 hints:[42] 같은 항목이 "검증된 백업"에 담겨 다른 기기에서 조용히 사라진다.
  it("번역 캐시 내보내기도 cacheKorean과 같은 검사·상한을 통과시킨다 (리뷰 2-15)", () => {
    window.localStorage.setItem(
      "enlearn.kocache.v3",
      JSON.stringify({
        "classic:ok": { ko: "정상 번역입니다.", hints: ["ok"] },
        "classic:bad-hints": { ko: "힌트가 숫자.", hints: [42] },
        "classic:bad-ko": { ko: 42, hints: [] },
      }),
    );

    const exported = exportKoreanCache();
    expect(Object.keys(exported).sort()).toEqual([
      "classic:bad-hints",
      "classic:ok",
    ]);
    expect(exported["classic:bad-hints"].hints).toEqual([]);
    expect(exported["classic:bad-ko"]).toBeUndefined();
    // 백업에 담기는 값은 모두 CachedKorean 선언에 맞는 모양이다
    for (const value of Object.values(exported)) {
      expect(typeof value.ko).toBe("string");
      expect(value.hints.every((h) => typeof h === "string")).toBe(true);
    }
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
    expect(accepted.stored).toBe(2);
    expect(accepted.rejected).toBe(2); // 빈 ko · 객체 아닌 항목

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

  it("이미 취소된 신호로도 기다리던 요청에 붙지 않는다 — withAbort의 사전 거부 (리뷰 4-9)", async () => {
    clearCorpusCache();
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    const spy = vi.fn(() => promise);
    vi.stubGlobal("fetch", spy);

    const inflight = loadCorpus("daily");
    const controller = new AbortController();
    controller.abort();
    // 이미 취소된 신호는 진행 중 작업에 붙지도 않는다
    await expect(loadCorpus("daily", controller.signal)).rejects.toThrow(/취소/);
    expect(spy).toHaveBeenCalledTimes(1);

    resolve(responseOf(file([entry({ en: "Still loading sentence here." })])));
    expect((await inflight).entries).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("연결 실패·JSON 해석 실패 안내 문장을 고정한다 (리뷰 4-9)", async () => {
    clearCorpusCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(loadCorpus("daily")).rejects.toThrow(/코퍼스에 연결할 수 없습니다 \(\/data\/corpus\/daily\.json\)/);
    vi.unstubAllGlobals();

    clearCorpusCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected end of JSON input");
        },
      }),
    );
    await expect(loadCorpus("classic")).rejects.toThrow(/코퍼스 JSON을 해석할 수 없습니다 \(\/data\/corpus\/classics\.json\)/);
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
    expect(importKoreanCache(bulk, true).stored).toBeLessThanOrEqual(MAX_KOREAN_CACHE);
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
    expect(accepted.stored).toBeLessThanOrEqual(MAX_SEEN);
    // 상한으로 잘린 개수가 따로 드러난다(D4-2/R6-3).
    expect(accepted.trimmed).toBe(10);
    expect(seenCount()).toBe(MAX_SEEN);
  });

  // 리뷰 4-9: 개수만 보는 상한 테스트는 "누가 살아남는가"를 고정하지 못한다.
  // 정렬 키가 어긋나도(예: 미래 날짜) 개수만 맞으면 통과했다.
  it("seen 상한은 가장 오래 안 본 항목부터 버린다 (리뷰 4-9)", () => {
    const bulk: Record<string, string> = {};
    for (let i = 0; i < MAX_SEEN; i++) {
      // 0번이 가장 오래 보고, 마지막이 가장 최근에 봤다.
      const when = new Date(Date.UTC(2020, 0, 1) + i * 60_000).toISOString();
      bulk[`classic:${i}:k`] = when;
    }
    importSeen(bulk, true);
    expect(seenCount()).toBe(MAX_SEEN);

    // 하나를 더 보면 가장 오래 안 본 0번이 밀려난다
    importSeen({ "classic:new:k": new Date().toISOString() });
    const seen = loadSeen();
    expect(seen["classic:0:k"]).toBeUndefined();
    expect(seen["classic:new:k"]).toBeTruthy();
    // 남은 쪽은 최신순으로 유지된다 (가장 최근 항목은 살아 있다)
    expect(seen[`classic:${MAX_SEEN - 1}:k`]).toBeTruthy();
    expect(seenCount()).toBe(MAX_SEEN);
  });

  it("번역 캐시 상한은 JSON에 들어온 순서에서 앞쪽(오래된) 것부터 버린다 (리뷰 4-9)", () => {
    const bulk: Record<string, { ko: string; hints: string[] }> = {};
    for (let i = 0; i < MAX_KOREAN_CACHE; i++) {
      bulk[`classic:${i}:order`] = { ko: `순서 확인 ${i}번 문장.`, hints: ["order"] };
    }
    importKoreanCache(bulk, true);
    // 끝에 한 항목을 더 넣으면 앞쪽(가장 오래 들어온 0번)이 밀려난다
    cacheKorean("classic:new:order", "마지막에 들어온 문장.", ["new"]);

    expect(koreanCacheCount()).toBe(MAX_KOREAN_CACHE);
    expect(getCachedKorean("classic:0:order")).toBeNull();
    expect(getCachedKorean("classic:1:order")).not.toBeNull();
    expect(getCachedKorean("classic:new:order")).not.toBeNull();
  });

  // 리뷰 3-6: trimSeen은 "본 시각" 문자열 순으로 오래된 것부터 버린다.
  // 형식 밖의 값("asdf")이 섞이면 그 항목 뒤로 밀려, 살아가야 할 최근 문장이 먼저 버려진다.
  it("형식 밖의 본 날짜는 지금 시각으로 바로잡는다", () => {
    importSeen(
      {
        "classic:1:ok": "2026-01-01T00:00:00.000Z",
        "classic:2:broken": "asdf",
        "classic:3:empty": "",
        "classic:4:number": 42,
        "classic:5:huge": "x".repeat(400),
      },
      true,
    );
    const seen = loadSeen();
    expect(seen["classic:1:ok"]).toBe("2026-01-01T00:00:00.000Z");
    for (const key of ["classic:2:broken", "classic:3:empty", "classic:5:huge"]) {
      expect(seen[key]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(seen[key].length).toBeLessThanOrEqual(40);
    }
    // 문자열이 아닌 값은 항목 자체를 버린다 (현행 규칙)
    expect(seen["classic:4:number"]).toBeUndefined();
  });

  it("형식 밖의 값이 상한 트림에서 최근 항목을 밀어내지 않는다 (리뷰 3-6)", () => {
    const bulk: Record<string, string> = {};
    // 상한까지 오래된 항목으로 채우고, 형식 밖의 값을 하나 섞는다
    for (let i = 0; i < MAX_SEEN; i++) {
      bulk[`classic:${i}:k`] = "2020-01-01T00:00:00.000Z";
    }
    bulk["classic:newest:k"] = "asdf";
    importSeen(bulk, true);

    const seen = loadSeen();
    expect(seenCount()).toBe(MAX_SEEN);
    // 지금 시각으로 바로잡혔으므로 트림에서 살아남는다
    expect(seen["classic:newest:k"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // 리뷰 4-4: trimSeen은 값 내림차순으로 앞을 버린다. 미래 시각을 통과시키면
  // 그 항목이 꼭대기를 차지하고 실제 최근 기록이 밀려난다.
  it("미래 본 시각은 상한 잘림에서 이기지 않는다 (리뷰 4-4)", () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const bulk: Record<string, string> = { "classic:newest:k": recent };
    for (let i = 0; i < MAX_SEEN; i++) {
      bulk[`classic:${i}:future`] = "2099-01-01T00:00:00.000Z";
    }
    const accepted = importSeen(bulk, true);

    const seen = loadSeen();
    // 미래 시각은 저장소에 들어오지 않는다
    expect(accepted.stored).toBe(1);
    expect(accepted.rejected).toBe(MAX_SEEN);
    expect(seenCount()).toBe(1);
    expect(seen["classic:0:future"]).toBeUndefined();
    // 실제 최근 기록은 그대로 살아남는다
    expect(seen["classic:newest:k"]).toBe(recent);
  });

  it("본 시각의 하한·하루 어긋난 시계 경계 (리뷰 4-4)", () => {
    importSeen(
      {
        "classic:1:skew": new Date(Date.now() + 3_600_000).toISOString(),
        "classic:2:far": "2099-01-01T00:00:00.000Z",
        "classic:3:ancient": "1999-12-31T00:00:00.000Z",
      },
      true,
    );
    const seen = loadSeen();
    // 시계가 하루 어긋난 정도는 그대로 둔다
    expect(seen["classic:1:skew"]).toMatch(/^\d{4}-/);
    // 그 이상의 미래와 2000년 이전은 항목을 버린다
    expect(seen["classic:2:far"]).toBeUndefined();
    expect(seen["classic:3:ancient"]).toBeUndefined();
  });

  // 리뷰 4-9: 백업 경로의 키 길이 가드와 번역 캐시 항목 검사가 0회였다.
  it("백업 키 길이 가드와 번역 캐시 항목 검사 (리뷰 4-9)", () => {
    const recent = new Date().toISOString();
    importSeen(
      {
        "": recent,
        ["k".repeat(81)]: recent,
        "classic:ok:k": recent,
      },
      true,
    );
    const seen = loadSeen();
    expect(Object.keys(seen)).toEqual(["classic:ok:k"]);

    importKoreanCache(
      {
        "": { ko: "키가 빈 항목", hints: [] },
        ["k".repeat(81)]: { ko: "키가 긴 항목", hints: [] },
        "classic:bad:hints": { ko: "힌트가 배열 아님", hints: "배열 아닌 값" },
        "classic:bad:ko": { ko: "   ", hints: [] },
        "classic:ok:k": { ko: "올바른 항목", hints: ["ok"] },
      },
      true,
    );
    const rawKorean = window.localStorage.getItem("enlearn.kocache.v3") ?? "{}";
    expect(Object.keys(JSON.parse(rawKorean))).toEqual(["classic:ok:k"]);
  });

  it("형식 밖의 본 시각(파싱 불가)은 지금 시각으로 바로잡는다 (리뷰 4-4)", () => {
    importSeen({ "classic:nan:k": "9999-99-99T00:00:00.000Z", "classic:ok:k": "2024-05-05T00:00:00.000Z" }, true);
    const seen = loadSeen();
    // 접두만 보면 통과하는 "달력상 없는 날짜"도 지금 시각으로 바로잡힌다
    expect(Number.isFinite(Date.parse(seen["classic:nan:k"]))).toBe(true);
    expect(seen["classic:ok:k"]).toBe("2024-05-05T00:00:00.000Z");
  });

  // D2-1(R6-2): 합치기의 "누가 이기나"가 저장소마다 달랐다. seen은 본 시각 기준.
  it("본 문장 합치기는 더 최근 본 시각이 이기고, 같으면 기존 값이 남는다 (D2-1)", () => {
    importSeen(
      {
        "classic:keep:k": "2026-06-01T00:00:00.000Z",
        "classic:newer:k": "2026-06-01T00:00:00.000Z",
        "classic:same:k": "2026-06-01T12:00:00.000Z",
      },
      true,
    );

    // 더 옛날에 봤다는 사본이 들어와도 최근 기록을 되돌리지 않는다.
    const older = importSeen({
      "classic:keep:k": "2020-01-01T00:00:00.000Z",
      "classic:newer:k": "2026-09-09T00:00:00.000Z",
      "classic:same:k": "2026-06-01T12:00:00.000Z",
    });
    // R7-1: 적용된 항목은 실제로 값이 들어간 1건뿐이다. 나머지 두 건은
    // 저장소에 키가 있다는 사실로 세면 "다 합쳤다"처럼 보인다.
    expect(older.stored).toBe(1);
    expect(older.merged).toBe(2);
    const seen = loadSeen();
    expect(seen["classic:keep:k"]).toBe("2026-06-01T00:00:00.000Z");
    // 더 최근 시각은 받아들여진다.
    expect(seen["classic:newer:k"]).toBe("2026-09-09T00:00:00.000Z");
    // 같은 시각이면 기존 값이 이긴다.
    expect(seen["classic:same:k"]).toBe("2026-06-01T12:00:00.000Z");
  });

  // R7-3: isNewerIso가 존재하는 이유(시간대 표기가 다른 값)와 "파싱되지 않는 시각" 갈래가
  // 테스트에 한 번도 지나가지 않았다. 문자열 비교라면 아래 세 갈래가 틀어진다.
  it("본 시각이 같은 순간의 다른 표기(+09:00 / Z)면 기존 값을 지킨다 (R7-3)", () => {
    importSeen({ "classic:offset:k": "2026-06-01T09:00:00+09:00" }, true);

    // 같은 순간(2026-06-01T00:00:00Z)을 다른 표기로 들여보낸다 → 같은 시각 = 기존 승리.
    importSeen({ "classic:offset:k": "2026-06-01T00:00:00.000Z" });
    expect(loadSeen()["classic:offset:k"]).toBe("2026-06-01T09:00:00+09:00");

    // 사전순으로는 "…T00:30…Z"가 "…T09:00…+09:00"보다 앞서지만 실제 시각은 뒤다.
    // 문자열 비교라면 이 합치기가 기존(더 최근) 값을 밀어버린다.
    const result = importSeen({ "classic:offset:k": "2026-06-01T00:30:00.000Z" });
    expect(loadSeen()["classic:offset:k"]).toBe("2026-06-01T00:30:00.000Z");
    expect(result.stored).toBe(1);
  });

  it("저장소에 이미 손상된 본 시각이 있으면 들어온 값을 받아들인다 (R7-3)", () => {
    // 과거 버전이 쓴 값처럼 저장소에 직접 심는다(normalizeSeenValue를 거치지 않은 경로).
    window.localStorage.setItem(
      "enlearn.seen.v3",
      JSON.stringify({ "classic:broken:k": "asdf", "classic:ok:k": "2026-06-01T00:00:00.000Z" }),
    );

    const result = importSeen({
      "classic:broken:k": "2026-07-07T00:00:00.000Z",
      "classic:ok:k": "2020-01-01T00:00:00.000Z",
    });
    const seen = loadSeen();
    // 파싱되지 않는 기존 값은 "가장 오래된 값"으로 취급되어 밀려난다.
    expect(seen["classic:broken:k"]).toBe("2026-07-07T00:00:00.000Z");
    // 정상 값은 원래 더 최근인 기존 값이 그대로 이긴다.
    expect(seen["classic:ok:k"]).toBe("2026-06-01T00:00:00.000Z");
    expect(result.stored).toBe(1);
    expect(result.merged).toBe(1);
  });

  it("형식 밖의 들어온 본 시각은 지금 시각으로 바뀌어 들어온다 (R7-3)", () => {
    importSeen({ "classic:now:k": "방금 봤다" }, true);
    const value = loadSeen()["classic:now:k"];
    expect(Number.isFinite(Date.parse(value))).toBe(true);
    expect(Math.abs(Date.parse(value) - Date.now())).toBeLessThan(60_000);
  });

  /*
   * R8-4: isNewerIso의 "들어온 시각이 파싱되지 않는다" 갈래는 방어 코드다(커버리지 0회).
   * 그 값을 비교에 넘기는 일은 없어야 한다는 사실을 합치기 경로에서 고정한다.
   */
  it("합치기도 비교에 앞서 형식 밖의 본 시각을 바로잡는다 (R8-4)", () => {
    importSeen({ "classic:guard:k": "2026-06-01T00:00:00.000Z" }, true);

    // replace가 아니라 병합 경로 — 정규화된 값이 아니면 isNewerIso에 도착한다.
    const result = importSeen({ "classic:guard:k": "asdf", "classic:bad:type": 42 });
    const seen = loadSeen();
    // 원본 문자열은 어디에도 들어가지 않는다.
    expect(seen["classic:guard:k"]).not.toBe("asdf");
    expect(Number.isFinite(Date.parse(seen["classic:guard:k"]))).toBe(true);
    expect(Math.abs(Date.parse(seen["classic:guard:k"]) - Date.now())).toBeLessThan(60_000);
    // 문자열이 아닌 값은 항목 자체를 버린다.
    expect(seen["classic:bad:type"]).toBeUndefined();
    expect(result.rejected).toBe(1);
    expect(result.stored).toBe(1);
  });

  // R7-2: 합치기 판정은 Date.parse로 하는데 상한 트림은 문자열 순서로 버리면,
  // 시간대 표기가 다른 저장소에서 살아남아야 할 최근 기록이 먼저 밀려난다.
  it("seen 상한 트림은 시간대 표기와 무관하게 실제 시각으로 버린다 (R7-2)", () => {
    const base = Date.UTC(2026, 0, 1);
    const bulk: Record<string, string> = {};
    for (let i = 0; i < MAX_SEEN; i++) {
      const when = base + i * 1_000;
      if (i % 2 === 0) {
        bulk[`classic:${i}:k`] = new Date(when).toISOString();
      } else {
        // 같은 순간을 "+09:00" 표기로 쓴다 — 사전순으로는 또래보다 훨씬 뒤로 밀린다.
        bulk[`classic:${i}:k`] = `${new Date(when + 9 * 3_600_000).toISOString().slice(0, -1)}+09:00`;
      }
    }
    // 가장 최근 항목을 "-11:00" 표기로 넣는다 — 사전순으로는 전체에서 가장 앞선다.
    bulk["classic:newest:k"] = `${
      new Date(base + MAX_SEEN * 1_000 - 11 * 3_600_000).toISOString().slice(0, -1)
    }-11:00`;

    importSeen(bulk, true);

    const seen = loadSeen();
    expect(seenCount()).toBe(MAX_SEEN);
    // 문자열 순서로 버렸다면 이 항목이 밀려났을 것이다.
    expect(seen["classic:newest:k"]).toBeTruthy();
    // 실제로 가장 오래된 0번이 밀려난다.
    expect(seen["classic:0:k"]).toBeUndefined();
  });

  it("번역 캐시 합치기는 기존 값(화면에 보여 검증된 번역)을 지킨다 (D2-1)", () => {
    cacheKorean("classic:keep:k", "기존 번역입니다.", ["old"]);
    const result = importKoreanCache({
      "classic:keep:k": { ko: "백업의 다른 번역입니다.", hints: ["new"] },
      "classic:new:k": { ko: "새로 들어온 번역입니다.", hints: ["new"] },
    });
    // R7-1: 같은 키(기존 번역이 이김)는 "적용되지 않음"으로 따로 센다.
    expect(result.stored).toBe(1);
    expect(result.merged).toBe(1);
    expect(getCachedKorean("classic:keep:k")?.ko).toBe("기존 번역입니다.");
    expect(getCachedKorean("classic:new:k")?.ko).toBe("새로 들어온 번역입니다.");

    // 상한을 넘기면 잘린 개수를 알려준다(D4-2).
    const bulk: Record<string, { ko: string; hints: string[] }> = {};
    for (let i = 0; i < MAX_KOREAN_CACHE + 50; i++) {
      bulk[`classic:${i}:cut`] = { ko: `자르는 확인 ${i}번 문장.`, hints: ["cut"] };
    }
    const trimmedResult = importKoreanCache(bulk, true);
    expect(trimmedResult.stored).toBe(MAX_KOREAN_CACHE);
    expect(trimmedResult.trimmed).toBe(50);
  });

  /*
   * R8-1: 쓰기 실패 시 저장소에 남은 이전 개수를 stored로 세면, 대체 항목이 그보다
   * 적을 때 trimmed가 음수가 된다. (되돌릴지 여부는 D6-3 — 여기서는 개수만 고정한다.)
   */
  it("대체 중 저장이 실패해도 본 문장·번역 캐시 개수가 음수가 아니다 (R8-1)", () => {
    const five: Record<string, string> = {};
    for (let i = 0; i < 5; i++) five[`classic:${i}:k`] = `2026-06-0${i + 1}T00:00:00.000Z`;
    importSeen(five, true);
    expect(seenCount()).toBe(5);
    for (let i = 0; i < 5; i++) cacheKorean(`classic:${i}:t`, `이전에 저장된 번역 ${i}번.`, ["old"]);
    expect(koreanCacheCount()).toBe(5);

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    try {
      const seen = importSeen({ "classic:new:k": "2026-06-09T00:00:00.000Z" }, true);
      expect(seen.stored).toBe(0);
      expect(seen.trimmed).toBe(0);
      expect(seen.rejected).toBe(0);

      const ko = importKoreanCache(
        { "classic:new:t": { ko: "새 번역입니다.", hints: ["new"] } },
        true,
      );
      expect(ko.stored).toBe(0);
      expect(ko.trimmed).toBe(0);
      expect(ko.rejected).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("저장이 실패하면 다음 읽기도 저장소의 이전 값을 본다 (파싱 캐시)", () => {
    markSeen("daily:1:kept");
    const before = window.localStorage.getItem("enlearn.seen.v3");

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    markSeen("daily:2:phantom");
    spy.mockRestore();

    // 메모리에 파싱 결과를 재사용해도, 실패한 변경이 화면에 보이지 않아야 한다
    expect(window.localStorage.getItem("enlearn.seen.v3")).toBe(before);
    expect("daily:2:phantom" in loadSeen()).toBe(false);
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
      importSeen({ "daily:9:zz": "2026-03-01T00:00:00.000Z" }, false).stored,
    ).toBe(0);
    expect(() => markSeen("daily:10:yy")).not.toThrow();
    vi.spyOn(Storage.prototype, "setItem").mockRestore();

    expect(seenCount()).toBe(before);
    expect("daily:9:zz" in loadSeen()).toBe(false);
  });
});

/*
 * R7-8: 키 이름이 v3으로 올라간 뒤에도 옛 키는 브라우저에 남아 용량을 먹는다.
 * 마이그레이션(값 옮기기)은 하지 않지만, 죽은 키는 지운다.
 */
describe("죽은 옛 키 정리 (R7-8)", () => {
  it("v2 키를 지우고 지금 키는 그대로 둔다", () => {
    window.localStorage.setItem(
      "enlearn.seen.v2",
      JSON.stringify({ "classic:old:k": "2025-01-01T00:00:00.000Z" }),
    );
    window.localStorage.setItem(
      "enlearn.kocache.v2",
      JSON.stringify({ "classic:old:k": { ko: "옛 번역입니다.", hints: [] } }),
    );
    markSeen("classic:current:k");
    cacheKorean("classic:current:k", "현재 번역입니다.", ["now"]);

    clearLegacyStorageKeys();

    expect(window.localStorage.getItem("enlearn.seen.v2")).toBeNull();
    expect(window.localStorage.getItem("enlearn.kocache.v2")).toBeNull();
    expect(seenCount()).toBe(1);
    expect(koreanCacheCount()).toBe(1);
  });

  // D6-5: practiceId가 64비트로 올라가면서 v1 연습 기록·복습 큐 키도 죽은 키가 됐다.
  it("v1 연습 기록·복습 큐 키도 지운다 (D6-5)", () => {
    window.localStorage.setItem(
      "enlearn.log.v1",
      JSON.stringify([{ id: "classic:31:1a2b3c4d", date: "2025-01-01" }]),
    );
    window.localStorage.setItem("enlearn.srs.v1", JSON.stringify([]));
    markSeen("classic:current:k");

    clearLegacyStorageKeys();

    expect(window.localStorage.getItem("enlearn.log.v1")).toBeNull();
    expect(window.localStorage.getItem("enlearn.srs.v1")).toBeNull();
    expect(seenCount()).toBe(1);
  });

  it("삭제가 실패해도 멈추지 않는다 — 화면 기능과 무관한 청소다", () => {
    window.localStorage.setItem("enlearn.seen.v2", "{}");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("SecurityError", "SecurityError");
    });
    expect(() => clearLegacyStorageKeys()).not.toThrow();
    vi.spyOn(Storage.prototype, "removeItem").mockRestore();
  });
});

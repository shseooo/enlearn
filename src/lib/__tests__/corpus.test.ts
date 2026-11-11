import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKorean,
  clearCorpusCache,
  clearKoreanCache,
  getCachedCorpus,
  getCachedKorean,
  getProgressServerSnapshot,
  getProgressSnapshot,
  isSeen,
  koreanCacheCount,
  loadCorpus,
  loadSeen,
  markSeen,
  pickEntry,
  prefillCorpus,
  resolveKorean,
  resetSeen,
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
    window.localStorage.setItem("enlearn.seen.v1", "{깨진 json");
    expect(seenCount()).toBe(0);
    markSeen("daily:x");
    expect(isSeen("daily:x")).toBe(true);
  });
});

describe("동화 문장의 한국어 캐시", () => {
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

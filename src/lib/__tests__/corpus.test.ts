import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKorean,
  clearCorpusCache,
  getCachedCorpus,
  getCachedKorean,
  isSeen,
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
    const picked = pickEntry(pool, {
      difficulty: "easy",
      sourceId: "b",
      seed: 3,
    });
    // 쉬운 문장이 b에 없으므로 출처 전체에서 다시 뽑는다 (recycled)
    expect(picked?.entry.sourceId).toBe("b");
    expect(picked?.recycled).toBe(true);
  });

  it("푼 문장은 다음 번 후보에서 빠진다", () => {
    const first = pickEntry(pool, { difficulty: "easy", seed: 5 });
    expect(first?.entry.en).toBe("Easy one goes here.");
    markSeen(entryKey(first!.entry));
    expect(isSeen(entryKey(first!.entry))).toBe(true);

    // 그 난이도에 안 푼 문장이 없으면 다시 출제(recycled) 표시
    const second = pickEntry(pool, { difficulty: "easy", seed: 5 });
    expect(second?.recycled).toBe(true);
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

/**
 * 코퍼스 빌드의 "실행 경로" 테스트 (리뷰 1-9).
 * 순수 함수(재시도 상태는 src/lib/http-status.ts, requestChatOnce/balanceByDifficulty)는
 * build-corpus.test.mts가 잡고, 여기서는 다운로드 산물(zip)·번역 캐시·
 * 재개 동작을 확인한다.
 *
 * ⚠️ build-corpus.mts는 import 시점에 경로를 계산한다. 실제 저장소를 건드리지
 * 않게 ENLEARN_CORPUS_ROOT를 임시 작업 공간으로 가리킨 뒤 import한다.
 */
import { deflateRawSync } from "node:zlib";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeKey } from "../../src/lib/corpus-tools.ts";
import type { CorpusEntry } from "../../src/lib/types.ts";

const WORKSPACE = mkdtempSync(join(tmpdir(), "enlearn-build-"));
process.env.ENLEARN_CORPUS_ROOT = WORKSPACE;

const {
  LLM_BATCH_SIZE,
  acceptsDailyKorean,
  cachedBytes,
  isCompleteGutenbergText,
  fillKoreanTranslations,
  loadTranslationCache,
  saveTranslationCache,
  unzipEntries,
} = await import("../build-corpus.mts");

afterAll(() => {
  delete process.env.ENLEARN_CORPUS_ROOT;
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const CACHE_FILE = join(WORKSPACE, ".corpus-cache", "translations.json");
const BOOK_CACHE_DIR = join(WORKSPACE, ".corpus-cache");

/*
 * R6-8(리뷰 5, 4차 리뷰 R5-1에서 이관): 캐시된 파일만 끝 마커를 확인했다.
 * 막 내려받은 바이트는 검사 없이 캐시에 쓰고 이번 빌드에도 그대로 들어갔다 —
 * 원본 서버가 잘린 파일을 주면 잘린 책이 조용히 코퍼스에 참여한다.
 */
describe("cachedBytes — 내려받은 원본도 완성본 검사 (R6-8)", () => {
  const END_MARKER = "\n*** END OF THE PROJECT GUTENBERG EBOOK 11 ***\n";

  function stubFetch(body: string) {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      body: null,
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("잘린 원본은 캐시에 쓰지 않고 오류로 끝난다", async () => {
    const fetchMock = stubFetch("Alice was beginning to get very tired… (여기서 잘림)");

    await expect(
      cachedBytes("pg-truncated.txt", ["https://example.test/pg11"], isCompleteGutenbergText),
    ).rejects.toThrow(/완성본이 아닙니다/);

    // 잘린 바이트가 캐시에 남으면 다음 빌드가 그 파일을 완성본으로 쓴다.
    expect(existsSync(join(BOOK_CACHE_DIR, "pg-truncated.txt"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("완성본만 캐시에 쓴다", async () => {
    stubFetch(`Alice was beginning to get very tired.${END_MARKER}`);

    const buf = await cachedBytes(
      "pg-complete.txt",
      ["https://example.test/pg11"],
      isCompleteGutenbergText,
    );
    expect(buf.toString()).toContain("END OF THE PROJECT GUTENBERG");
    expect(readFileSync(join(BOOK_CACHE_DIR, "pg-complete.txt"), "utf8")).toContain(
      "END OF THE PROJECT GUTENBERG",
    );
  });

  it("끝 마커 검사 없는 자료(zip 등)는 그대로 캐시한다", async () => {
    stubFetch("zip바이트 흉내");
    const buf = await cachedBytes("raw.bin", ["https://example.test/raw"]);
    expect(buf.toString()).toBe("zip바이트 흉내");
  });
});

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mkdirSync(join(WORKSPACE, ".corpus-cache"), { recursive: true });
  writeFileSync(CACHE_FILE, "{}");
});

// ---------------------------------------------------------------------------
// 한글 판정 (리뷰 1-5)
// ---------------------------------------------------------------------------

describe("acceptsDailyKorean — daily 레인의 한국어 필터", () => {
  it("한글이 한 자도 없는 일본어·중국어 문장은 거른다", () => {
    // U+3131–U+D79D에는 CJK 한자·Bamum까지 들어 있었다(옛 판정 범위).
    expect(acceptsDailyKorean("猫が寝ています.")).toBe(false);
    expect(acceptsDailyKorean("我今天去学校.")).toBe(false);
    expect(acceptsDailyKorean("ꄀꄁꄂꄃ.")).toBe(false); // Bamum 실러블
  });

  it("한글 문장은 길이·종료 부호를 지켜 통과한다", () => {
    expect(acceptsDailyKorean("고양이가 매트 위에 앉아 있다.")).toBe(true);
    expect(acceptsDailyKorean("简短です")).toBe(false); // 종료 부호 없음
    expect(acceptsDailyKorean("짧다")).toBe(false); // 4자 미만
    expect(acceptsDailyKorean("가".repeat(81) + ".")).toBe(false); // 80자 초과
  });
});

// ---------------------------------------------------------------------------
// zip 파서 (리뷰 1-17)
// ---------------------------------------------------------------------------

/** 중앙 디렉터리를 직접 만든다 (stored + deflate 혼합). */
function makeZip(files: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = file.deflate ? deflateRawSync(file.data) : file.data;
    const name = Buffer.from(file.name, "utf8");

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, raw);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + raw.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralDirectory, eocd]);
}

describe("unzipEntries — 내려받은 zip (리뷰 1-17)", () => {
  const text = "Tom looks very sick.\t톰은 많이 아파 보여.\n";

  it("deflate/stored 항목을 이름과 함께 펼친다", () => {
    const zip = makeZip([
      { name: "kor-eng.txt", data: Buffer.from(text, "utf8"), deflate: true },
      { name: "readme.txt", data: Buffer.from("CC-BY", "utf8") },
    ]);
    const entries = unzipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["kor-eng.txt", "readme.txt"]);
    expect(entries[0].data.toString("utf8")).toBe(text);
    expect(entries[1].data.toString("utf8")).toBe("CC-BY");
  });

  it("잘린 파일은 원인 없는 RangeError 대신 한국어 오류로 멈춘다", () => {
    const zip = makeZip([
      { name: "kor-eng.txt", data: Buffer.from(text, "utf8"), deflate: true },
    ]);
    // 중앙 디렉터리를 잘어내 항목 수/오프셋이 파일 길이를 넘게 만든다.
    const truncated = zip.subarray(0, zip.length - 20);
    let error: unknown = null;
    try {
      unzipEntries(truncated);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe("RangeError");
    expect((error as Error).message).toMatch(/zip 구조/);
  });

  it("로컬 헤더 위치가 잘못된 zip도 안내 문구로 거부한다", () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("abc", "utf8") }]);
    const eocd = zip.length - 22;
    const centralOff = zip.readUInt32LE(eocd + 16);
    // 중앙 디렉터리가 가리키는 로컬 헤더 위치를 파일 밖으로 옮긴다.
    zip.writeUInt32LE(zip.length + 100, centralOff + 42);
    expect(() => unzipEntries(zip)).toThrow(/로컬 파일 헤더 위치|zip 구조/);
  });

  it("EOCD가 없으면 읽을 수 없다고 말한다", () => {
    expect(() => unzipEntries(Buffer.from("not a zip file at all"))).toThrow(/EOCD/);
  });

  it("펼친 지나는 비정상적으로 큰 항목은 OOM 크래시 대신 안내로 멈춘다 (리뷰 3-10)", () => {
    // 압축은 작고 출력은 큰 항목(영지버섯 zip). 압축 크기만 검사하면 그대로 펼쳤다.
    const zip = makeZip([
      { name: "kor-eng.txt", data: Buffer.alloc(64 * 1024 * 1024), deflate: true },
    ]);
    expect(zip.length).toBeLessThan(500_000);
    expect(() => unzipEntries(zip)).toThrow(/비정상적으로 큽니다/);
  });

  it("상한 안의 항목은 그대로 펼친다", () => {
    const text2 = "Tom looks very sick.\t톰은 많이 아파 보여.\n".repeat(2000);
    const zip = makeZip([{ name: "kor-eng.txt", data: Buffer.from(text2, "utf8"), deflate: true }]);
    expect(unzipEntries(zip)[0].data.toString("utf8")).toBe(text2);
  });
});

// ---------------------------------------------------------------------------
// 번역 재사용 캐시 (리뷰 1-3)
// ---------------------------------------------------------------------------

describe("번역 캐시 쓰기·읽기", () => {
  it("임시 파일로 썼다가 이름을 바꾼다 (.tmp가 남지 않는다)", () => {
    saveTranslationCache({ "tom looks sick": { ko: "톰은 아파 보여.", hints: ["sick"] } });
    expect(readFileSync(CACHE_FILE, "utf8")).toContain("톰은 아파 보여.");
    expect(existsSync(`${CACHE_FILE}.tmp`)).toBe(false);
    expect(loadTranslationCache()).toEqual({
      "tom looks sick": { ko: "톰은 아파 보여.", hints: ["sick"] },
    });
  });

  it("손상된 캐시는 조용히 {}로 바꾸지 않고, 손상 사본을 남긴다", () => {
    writeFileSync(CACHE_FILE, '{"a": { "ko": "번역'); // 쓰기 도중에 멈춘 것처럼
    expect(() => loadTranslationCache()).toThrow(/손상되었습니다/);
    expect(existsSync(`${CACHE_FILE}.corrupt`)).toBe(true);
    expect(readFileSync(`${CACHE_FILE}.corrupt`, "utf8")).toContain('"번역');
    // 원래 자리는 비어 있어 다음 쓰기가 새로 채울 수 있다
    expect(existsSync(CACHE_FILE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LLM 번역 채우기: 재사용 · 배치 · 실패 후 재개 (리뷰 1-9)
// ---------------------------------------------------------------------------

function entry(en: string): CorpusEntry {
  return {
    lane: "classic",
    en,
    ko: null,
    hints: [],
    difficulty: "normal",
    source: "테스트 책",
    sourceId: "1",
  };
}

const ENV = { host: "https://llm.example/v1", model: "m", apiKey: "k" };

/** 요청 본문에 적힌 문장 번호에 맞춰 {"items":[...]} 응답을 만든다. */
function okResponse(sentences: string[]) {
  const items = sentences.map((_, i) => ({
    i: i + 1,
    ko: `번역 ${i + 1}번 문장입니다.`,
    hints: ["walk"],
  }));
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ items }) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 요청 본문의 번호 붙은 문장 목록을 되돌린다. */
function sentencesOf(requestBody: unknown): string[] {
  const body = requestBody as { messages: { content: string }[] };
  const userContent = body.messages[1].content;
  return userContent
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

describe("fillKoreanTranslations", () => {
  it("이미 번역한 문장은 요청하지 않고, 남은 문장만 배치로 보낸다", async () => {
    saveTranslationCache({
      [normalizeKey("Already translated one.")]: {
        ko: "이미 번역된 문장입니다.",
        hints: ["already"],
      },
    });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(sentencesOf(JSON.parse(String(init.body)))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = [
      entry("Already translated one."),
      entry("First untranslated sentence."),
      entry("Second untranslated sentence."),
    ];
    await fillKoreanTranslations(entries, ENV);

    expect(entries[0].ko).toBe("이미 번역된 문장입니다.");
    expect(entries[0].hints).toEqual(["already"]);
    expect(entries[1].ko).toBe("번역 1번 문장입니다.");
    expect(entries[2].ko).toBe("번역 2번 문장입니다.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("배치는 LLM_BATCH개씩 나뉜다", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(sentencesOf(JSON.parse(String(init.body)))),
    );
    vi.stubGlobal("fetch", fetchMock);

    const total = LLM_BATCH_SIZE * 2 + 1;
    const entries = Array.from({ length: total }, (_, i) =>
      entry(`Sentence number ${i}.`),
    );
    await fillKoreanTranslations(entries, ENV);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(entries.every((e) => e.ko)).toBe(true);
  });

  it("잘못된 요청(400)은 재시도하지 않고 배치만 실패로 남긴다", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("bad request", { status: 400, statusText: "Bad Request" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const entries = [entry("Sentence that fails with 400.")];
    await fillKoreanTranslations(entries, ENV);

    // 400은 두 번 시도해도 같으므로 1회만 요청한다
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries[0].ko).toBeNull();
    expect(loadTranslationCache()).toEqual({});
  });

  it("실패한 배치는 캐시를 더럽히지 않고, 다시 실행하면 그 자리에서 이어간다", async () => {
    const entries = [entry("Broken batch sentence."), entry("Another broken one.")];

    // 1차: 응답은 왔지만 번역 항목이 없다 → 실패로 셈(캐시에 아무것도 들어가지 않는다)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "번역할 수 없습니다." } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await fillKoreanTranslations(entries, ENV);
    expect(entries.every((e) => e.ko === null)).toBe(true);
    expect(loadTranslationCache()).toEqual({});

    // 2차: 같은 목록을 다시 넘기면(재개) 이번에는 번역이 채워진다
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      okResponse(sentencesOf(JSON.parse(String(init.body)))),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fillKoreanTranslations(entries, ENV);

    expect(entries.map((e) => e.ko)).toEqual([
      "번역 1번 문장입니다.",
      "번역 2번 문장입니다.",
    ]);
    // 캐시에 저장됐으니, 세 번째 실행은 요청 없이 재사용한다
    const second = vi.fn();
    vi.stubGlobal("fetch", second);
    await fillKoreanTranslations(entries, ENV);
    expect(second).not.toHaveBeenCalled();
  });
});

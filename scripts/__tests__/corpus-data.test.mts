/**
 * 실제 커밋된 코퍼스 데이터(public/data/corpus/*.json)의 품질을 고정한다.
 * 사전 번역을 합친 뒤에도 다른 언어가 섞이지 않았는지 CI에서 확인하는 마지막 안전망이다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CorpusEntry, CorpusFile } from "../../src/lib/types";

import { foreignLetterRuns, hasHangul } from "../lib/foreign-text.ts";

/**
 * 한국어 문장 안에서 정당한 라틴 문자.
 * Tatoeba가 제공한 일상 회화 번역의 고유명사·약어이고, 동화 레인에서는 쓰이지 않는다.
 */
const ALLOWED_LATIN = new Set(["Tom", "Mary", "TV", "DNA", "MRI", "A", "B", "C"]);

/** 레인 이름과 파일 이름이 다르다(classic → classics.json). */
function load(lane: "daily" | "classic"): CorpusFile {
  const file = lane === "daily" ? "daily.json" : "classics.json";
  // vitest는 저장소 루트에서 돌린다(package.json의 test 스크립트).
  return JSON.parse(readFileSync(resolve(process.cwd(), "public", "data", "corpus", file), "utf8")) as CorpusFile;
}

const daily = load("daily");
const classics = load("classic");
const all: CorpusEntry[] = [...daily.entries, ...classics.entries];

describe("코퍼스 데이터 품질", () => {
  // 개수는 scripts/build-corpus.mts의 DAILY_CAP / CLASSIC_CAP과 짝을 이룬다. 한도를 바꾸면 함께 고친다.
  it("두 레인 모두 기대한 개수를 담는다", () => {
    expect(daily.entries.length).toBe(3000);
    expect(classics.entries.length).toBe(1400);
  });

  it("모든 문장에 한국어가 있다", () => {
    const missing = all.filter((e) => !e.ko?.trim()).map((e) => e.en);
    expect(missing.slice(0, 5)).toEqual([]);
  });

  it("한국어 번역에 다른 언어 문자가 섞이지 않았다", () => {
    const bad = all
      // 번역 원고 검사(check-translations.mts)과 같은 규칙으로 본다.
      .filter((e) => foreignLetterRuns(e.ko ?? "", ALLOWED_LATIN).length > 0)
      .map((e) => `${e.ko} → ${foreignLetterRuns(e.ko ?? "", ALLOWED_LATIN).join("|")}`);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("한국어 번역은 한글을 담고 문장 부호로 끝난다", () => {
    const bad = all
      .map((e) => e.ko ?? "")
      // 판정은 공통 규칙(scripts/lib/foreign-text.ts)을 쓴다 — 각자 다른 정규식을
      // 두면 "한 곳은 통과하고 다른 곳은 실패"하는 상태가 남는다(리뷰 1-11).
      .filter((ko) => !hasHangul(ko) || !/[.!?"»’]$/.test(ko.trim()));
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("영어 원문이 두 번 들어 있지 않다", () => {
    for (const file of [daily, classics]) {
      const keys = file.entries.map((e) => e.en.trim().toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("힌트는 영어 단어만 담고 개수를 넘지 않는다", () => {
    const bad: string[] = [];
    for (const e of classics.entries) {
      if (e.hints.length > 6) bad.push(`${e.en} — 힌트 ${e.hints.length}개`);
      for (const h of e.hints) if (!/^[A-Za-z][A-Za-z'-]*$/.test(h)) bad.push(`${e.en} — 힌트 "${h}"`);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("출처 정보가 비어 있지 않다", () => {
    const bad = all.filter((e) => (e.source?.trim().length ?? 0) < 3).map((e) => e.en);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

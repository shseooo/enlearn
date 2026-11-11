/**
 * 원자적 쓰기 헬퍼(R4-1).
 * 코퍼스 산출물과 번역 캐시는 사람이 옮긴 자료의 유일한 사본이다.
 * 쓰는 도중에 죽거나 rename이 실패해도 기존 파일이 그대로 남아야 한다.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { writeAtomic, writeJsonAtomically } from "../lib/json-file.ts";

let root = "";
let caseIndex = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "enlearn-atomic-"));
});

/** 테스트마다 다른 폴더를 쓴다 — 앞 테스트의 tmp 잔여물이 결과를 흐리지 않게. */
function caseDir(name: string): string {
  const dir = join(root, `${++caseIndex}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 임시 파일 잔여물(.tmp)이 남아 있지 않은지 확인하는 보조 함수 */
function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeAtomic — 제자리 덮어쓰기를 하지 않는다 (리뷰 4-1)", () => {
  it("문서화된 방식으로 쓰면 내용만 남고 임시 파일은 남지 않는다", () => {
    const dir = caseDir("plain");
    const target = join(dir, "classics.json");
    writeAtomic(target, JSON.stringify({ entries: [1, 2, 3] }));
    expect(JSON.parse(readFileSync(target, "utf8")).entries).toEqual([1, 2, 3]);
    expect(tempFiles(dir)).toEqual([]);
  });

  it("rename이 실패해도 기존 대상은 그대로고, 조각(tmp)을 남기지 않는다", () => {
    // 대상이 디렉터리면 rename이 실패한다(쓰기 실패의 대표 경로).
    const dir = caseDir("rename-fail");
    const target = join(dir, "broken-dir");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep.txt"), "사람이 옮긴 번역");

    expect(() => writeAtomic(target, "새 본문")).toThrow();
    // 기존 내용은 건드릴 수 없다
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("사람이 옮긴 번역");
    // 완성이 아닌 조각이 같은 자리에 굴러다니면 안 된다
    expect(tempFiles(dir)).toEqual([]);
  });

  it("tmp 이름은 프로세스 고유값이다 — 고정 `${path}.tmp`를 쓰지 않는다", () => {
    const dir = caseDir("unique-tmp");
    const target = join(dir, "translations.json");
    // 옛 방식(고정 이름)이었다면 이 더미 파일이 덮어써지거나 사라진다.
    const legacyTemp = `${target}.tmp`;
    writeFileSync(legacyTemp, "다른 프로세스가 쓰는 중");

    writeAtomic(target, "새 번역 캐시");

    expect(readFileSync(target, "utf8")).toBe("새 번역 캐시");
    expect(readFileSync(legacyTemp, "utf8")).toBe("다른 프로세스가 쓰는 중");
    expect(tempFiles(dir)).toEqual(["translations.json.tmp"]);
  });

  it("두 프로세스가 같은 대상을 써도 서로의 tmp를 밟지 않는다", () => {
    const dir = caseDir("race");
    const target = join(dir, "race.json");
    // 같은 대상에 대한 쓰기 두 번이 모두 살아남아야 한다(고정 tmp 이름이면 ENOENT).
    const bodies = ["A".repeat(50_000), "B".repeat(50_000)];
    for (const body of bodies) writeAtomic(target, body);
    expect(readFileSync(target, "utf8")).toBe(bodies[1]);
    expect(tempFiles(dir)).toEqual([]);
  });

  it("writeJsonAtomically는 같은 헬퍼를 쓴다", () => {
    const dir = caseDir("json");
    const target = join(dir, "cache.json");
    writeJsonAtomically(target, { ko: "한글" });
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ ko: "한글" });
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

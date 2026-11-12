/**
 * 감사 스크립트(audit-translations.mts)의 검사와 종료 코드를 고정한다 (리뷰 3-3).
 *
 * 사람 손으로 옮긴 1,400문장의 마지막 게이트인데, 다섯 검사 중 "빌드 미반영" 하나만
 * 테스트되어 있었다(translation-workflow.test.mts). 여기서는 누역·언어 오염·중복·
 * 모양과 코퍼스 파일이 망가졌을 때의 동작(크래시 아니라 안내)을 고정한다.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO = process.cwd();
const SCRIPT = join(REPO, "scripts", "audit-translations.mts");

const workspaces: string[] = [];

type Row = { en: string; ko: string | null };

/** 코퍼스와 번역 캐시를 직접 놓고 감사를 돌릴 임시 작업 공간을 만든다. */
function workspace(rows: Row[], cache: unknown = {}): string {
  const root = mkdtempSync(join(tmpdir(), "enlearn-audit-"));
  workspaces.push(root);
  mkdirSync(join(root, "public", "data", "corpus"), { recursive: true });
  mkdirSync(join(root, ".corpus-cache"), { recursive: true });
  writeFileSync(
    join(root, "public", "data", "corpus", "classics.json"),
    JSON.stringify({
      lane: "classic",
      generatedAt: "2026-01-01T00:00:00.000Z",
      license: "public domain",
      attribution: "테스트",
      sources: [],
      entries: rows.map((row) => ({
        lane: "classic",
        en: row.en,
        ko: row.ko,
        hints: [],
        difficulty: "normal",
        source: "테스트 책",
        sourceId: "alice",
      })),
    }),
  );
  writeFileSync(join(root, ".corpus-cache", "translations.json"), JSON.stringify(cache));
  return root;
}

function audit(root: string, args: string[] = []): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

describe("audit-translations.mts — 마지막 게이트 (리뷰 3-3)", () => {
  /*
   * D4-3(R6-12): 커밋된 데이터에 이미 있는 Tom/Mary 때문에 check-translations는
   * --allow로 넘기고 audit는 종료 코드 1로 죽는 불일치가 있었다. 두 스크립트가
   * 같은 기준 목록(scripts/lib/foreign-text.ts)을 쓰면서 감사도 통과한다.
   */
  it("기준 허용 목록의 고유명사는 감사도 통과한다 (D4-3)", () => {
    const root = workspace([
      { en: "Tom looks very sick.", ko: "Tom은 많이 아파 보여." },
      { en: "Mary opened the window slowly.", ko: "Mary는 창문을 천천히 열었다." },
    ]);
    const r = audit(root);
    expect(r.out, r.out).not.toContain("섞임");
    expect(r.status).toBe(0);
  });

  it("audit에도 --allow로 추가 허용을 받을 수 있다 (D4-3)", () => {
    const root = workspace([
      { en: "The DVR played a funny film.", ko: "그 DVR 영상은 아주 재밌었어요." },
    ]);
    expect(audit(root).status).toBe(1);
    const allowed = audit(root, ["--allow=DVR"]);
    expect(allowed.out, allowed.out).toContain("감사 통과");
    expect(allowed.status).toBe(0);

    // 잘못된 인자는 사용법(종료 코드 2)으로 알린다 — 스택 트레이스를 보여주지 않는다.
    const bad = audit(root, ["--nope"]);
    expect(bad.status).toBe(2);
    expect(bad.out).toContain("알 수 없는 인자");
    expect(bad.out).not.toMatch(/^\s+at /m);
  });

  it("한국어가 없는 문장이 있으면 누역으로 잡히고 종료 코드 1", () => {
    const root = workspace([
      { en: "The rabbit hopped away quickly.", ko: "토끼가 잽싸게 뛰어가 버렸다." },
      { en: "Alice felt very sleepy indeed.", ko: null },
    ]);
    const r = audit(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("누역 1");
    expect(r.out).not.toContain("감사 통과");
  });

  it("한국어에 다른 언어 문자가 섞이면 언어 오염으로 잡히고 종료 코드 1", () => {
    const root = workspace([
      { en: "The Queen turned red with anger.", ko: "여왕은 VERY 화가 나서 붉어졌다." },
    ]);
    const r = audit(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("언어 오염 1");
    expect(r.out).toContain("여왕은 VERY");
  });

  it("서로 다른 두 문장에 같은 한국어가 붙으면 경고하고 종료 코드 0 (문서에 약속된 동작)", () => {
    const root = workspace([
      { en: "The rabbit hopped away quickly.", ko: "토끼가 잽싸게 뛰어가 버렸다." },
      { en: "Alice followed the rabbit down the hole.", ko: "토끼가 잽싸게 뛰어가 버렸다." },
    ]);
    const r = audit(root);
    expect(r.out).toContain("중복 번역 1");
    expect(r.out).toContain("감사 통과");
    expect(r.status).toBe(0);
  });

  it("모양 경고는 종료를 실패시키지 않는다 (판단은 사람에게 맡긴다)", () => {
    const root = workspace([
      { en: "A very long sentence that should trip the shape check.", ko: "짧음" },
    ]);
    const r = audit(root);
    expect(r.out).toContain("모양 경고");
    expect(r.out).toContain("중복 번역 0");
    expect(r.status).toBe(0);
  });

  it("entries가 없는 코퍼스 파일은 크래시 대신 한국어 안내로 끝난다", () => {
    const root = workspace([{ en: "Unused.", ko: "쓰지 않는 문장입니다." }]);
    writeFileSync(
      join(root, "public", "data", "corpus", "classics.json"),
      JSON.stringify({ lane: "classic", generatedAt: "x" }),
    );
    const r = audit(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("코퍼스 파일 형식이 올바르지 않습니다");
    // 사용자에게 필요한 것은 원인과 다음 조치 한 줄이지 스택 트레이스가 아니다(R2-6과 같은 종류)
    expect(r.out).not.toMatch(/^\s+at /m);
    expect(r.out).not.toContain("TypeError");
  });

  it("0문장 코퍼스는 감사를 통과시키지 않는다 (리뷰 3-1의 마지막 안전망)", () => {
    const root = workspace([]);
    const r = audit(root);
    expect(r.status).toBe(1);
    expect(r.out).toContain("코퍼스");
    expect(r.out).toContain("0문장");
    expect(r.out).not.toContain("감사 통과");
  });
});

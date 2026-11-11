/**
 * 번역 원고 검사기(check-translations.mts)의 종료 코드·경로 해석·--allow를 고정한다.
 * 원고를 사람 손으로 고칠 때 유일한 게이트인데 직접 테스트가 없었다(리뷰 1-9).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// vitest는 저장소 루트에서 돌린다. 스크립트는 cwd(임시 작업 공간) 기준으로 찾는다.
const REPO = process.cwd();
const SCRIPT = join(REPO, "scripts", "check-translations.mts");

const workspaces: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "enlearn-check-"));
  mkdirSync(join(root, ".corpus-cache", "ko"), { recursive: true });
  workspaces.push(root);
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

function run(root: string, args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("check-translations.mts", () => {
  it("한글만 있는 원고는 문제 없이 끝난다 (종료 코드 0)", () => {
    const root = workspace();
    writeFileSync(
      join(root, "clean.txt"),
      "0\t두꺼비는 그냥 마음을 놓았다.\n1\t앨리스는 아주 지겨워지기 시작했습니다.\n",
    );
    const r = run(root, ["clean.txt"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain("줄 2개 / 문제 0건");
  });

  it("외국어 문자가 섞인 줄을 짚고 종료 코드 1로 끝난다", () => {
    const root = workspace();
    writeFileSync(join(root, "dirty.txt"), "0\t문장에 TV가 섞였다.\n");
    const r = run(root, ["dirty.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("외국어 문자 [TV]");
    expect(r.out).toContain("dirty.txt:1");
  });

  it("--allow로 허용한 조각은 넘긴다", () => {
    const root = workspace();
    writeFileSync(join(root, "allowed.txt"), "0\t그 TV 프로그램은 재밌어요.\n");

    expect(run(root, ["allowed.txt"]).status).toBe(1);
    const allowed = run(root, ["--allow=TV", "allowed.txt"]);
    expect(allowed.status).toBe(0);
    expect(allowed.out).toContain("문제 0건");
  });

  it("한글이 아예 없는 줄도 문제로 잡는다", () => {
    const root = workspace();
    // 외국어 문자는 없지만 한글도 없는 줄 → "외국어 문자"가 아니라 "한글 없음"으로 잡힌다
    writeFileSync(join(root, "blank.txt"), "0\t1234 — 5678\n");
    const r = run(root, ["blank.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("한글 없음");
  });

  it("파일 경로는 현재 위치와 .corpus-cache/ 아래에서 모두 찾는다", () => {
    const root = workspace();
    writeFileSync(
      join(root, ".corpus-cache", "ko", "chunk-0001.txt"),
      "0\t코퍼스 캐시 안의 원고입니다.\n",
    );
    const r = run(root, [".corpus-cache/ko/chunk-0001.txt"]);
    expect(r.status).toBe(0);

    // 같은 파일을 상대 경로 하나로도 찾는다(.corpus-cache 기준)
    const shortcut = run(root, ["ko/chunk-0001.txt"]);
    expect(shortcut.status).toBe(0);
  });

  it("없는 파일은 한국어 안내로 실패하고, 인자가 없으면 사용법(종료 코드 2)을 보여준다", () => {
    const root = workspace();
    const missing = run(root, ["nope.txt"]);
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain("파일을 찾을 수 없습니다");

    const usage = run(root, []);
    expect(usage.status).toBe(2);
    expect(usage.out).toContain("사용:");
  });
});

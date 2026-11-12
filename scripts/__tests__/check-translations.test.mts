/**
 * 번역 원고 검사기(check-translations.mts)의 종료 코드·경로 해석·--allow·원고 형식을 고정한다.
 * 원고를 사람 손으로 고칠 때 유일한 게이트인데 직접 테스트가 없었다(리뷰 1-9).
 *
 * 원고 형식은 D3-2부터 세 컬럼이다: <번호>\t<원문 앞부분>\t<번역>
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BASE_ALLOWED_LATIN } from "../lib/foreign-text.ts";

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
      "0\tThe frog thought about it a lit\t두꺼비는 그냥 마음을 놓았다.\n" +
        "1\tAlice was beginning to get ve\t앨리스는 아주 지겨워지기 시작했습니다.\n",
    );
    const r = run(root, ["clean.txt"]);
    expect(r.out).toContain("줄 2개 / 문제 0건");
    expect(r.status).toBe(0);
  });

  it("외국어 문자가 섞인 줄을 짚고 종료 코드 1로 끝난다", () => {
    const root = workspace();
    writeFileSync(
      join(root, "dirty.txt"),
      "0\tThe sentence mentions DVR hea\t문장에 DVR가 섞였다.\n",
    );
    const r = run(root, ["dirty.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("외국어 문자 [DVR]");
    expect(r.out).toContain("dirty.txt:1");
  });

  // D4-3(R6-12): 커밋 데이터에 이미 있는 Tom/Mary 때문에 check는 --allow로 넘기고
  // audit는 죽는 불일치가 있었다. 기준 목록은 이제 한 개다.
  it("기준 허용 목록의 단어는 --allow 없이도 통과한다 (D4-3)", () => {
    const root = workspace();
    for (const entry of BASE_ALLOWED_LATIN) {
      const file = join(root, "base-allowed.txt");
      writeFileSync(file, `0\tLook at the ${entry.word} in the roo\t${entry.word} 장면을 봤어요.\n`);
      const r = run(root, ["base-allowed.txt"]);
      expect(r.out, `${entry.word}: ${r.out}`).toContain("문제 0건");
      expect(r.status, `${entry.word}`).toBe(0);
    }
  });

  it("--allow는 기준 목록에 더하는 용도다 (D4-3)", () => {
    const root = workspace();
    writeFileSync(
      join(root, "allowed.txt"),
      "0\tThe DVR played a funny film t\t그 DVR 영상은 재밌었어요.\n",
    );
    expect(run(root, ["allowed.txt"]).status).toBe(1);
    const allowed = run(root, ["--allow=DVR", "allowed.txt"]);
    expect(allowed.status).toBe(0);
    expect(allowed.out).toContain("문제 0건");
  });

  it("원문 앞부분 컬럼의 라틴 문자는 외국어 오염으로 잡지 않는다 (R6-4)", () => {
    const root = workspace();
    writeFileSync(
      join(root, "prefix.txt"),
      "0\tThe Queen shouted at Alice an\t왕비가 앨리스에게 소리질렀다.\n",
    );
    const r = run(root, ["prefix.txt"]);
    expect(r.out).toContain("문제 0건");
    expect(r.status).toBe(0);
  });

  it("두 칸짜리 옛 형식(<번호>\\t<번역>)은 형식 문제로 잡는다 (D3-2)", () => {
    const root = workspace();
    writeFileSync(join(root, "old.txt"), "0\t옛 형식으로 쓴 번역입니다.\n");
    const r = run(root, ["old.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("원고 형식");
  });

  it("한글이 아예 없는 줄도 문제로 잡는다", () => {
    const root = workspace();
    // 외국어 문자는 없지만 한글도 없는 줄 → "외국어 문자"가 아니라 "한글 없음"으로 잡힌다
    writeFileSync(join(root, "blank.txt"), "0\tThe prompt line\t1234 — 5678\n");
    const r = run(root, ["blank.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("한글 없음");
  });

  it("빈 줄 뒤에도 실제 파일 줄 번호를 짚는다 (리뷰 3-5)", () => {
    const root = workspace();
    // 빈 줄을 지운 뒤 인덱스를 줄 번호로 쓰면, 안내가 앞줄을 가리켰다.
    writeFileSync(
      join(root, "mixed.txt"),
      "0\tThe first line is fine and cl\t첫 줄은 정상입니다.\n" +
        "\n" +
        "1\tThe third line has English\tThis line has English text mixed in.\n",
    );
    const r = run(root, ["mixed.txt"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("mixed.txt:3");
    expect(r.out).not.toContain("mixed.txt:2");
    // 검사한 줄 수는 빈 줄를 세지 않는다
    expect(r.out).toContain("줄 2개");
  });

  it("파일 경로는 현재 위치와 .corpus-cache/ 아래에서 모두 찾는다", () => {
    const root = workspace();
    writeFileSync(
      join(root, ".corpus-cache", "ko", "chunk-0001.txt"),
      "0\tA line stored under the cache\t코퍼스 캐시 안의 원고입니다.\n",
    );
    const r = run(root, [".corpus-cache/ko/chunk-0001.txt"]);
    expect(r.status).toBe(0);

    // 같은 파일을 상대 경로 하나로도 찾는다(.corpus-cache 기준)
    const shortcut = run(root, ["ko/chunk-0001.txt"]);
    expect(shortcut.status).toBe(0);
  });

  // R6-9: 없는 파일을 줬을 때 안내 뒤에 스택 트레이스가 따라 나왔다.
  it("없는 파일은 한국어 안내로 실패하고, 인자가 없으면 사용법(종료 코드 2)을 보여준다", () => {
    const root = workspace();
    const missing = run(root, ["nope.txt"]);
    expect(missing.status).toBe(1);
    expect(missing.out).toContain("파일을 찾을 수 없습니다");
    // audit·dump와 같은 계약: 스택 트레이스를 보여주지 않는다(R6-9).
    expect(missing.out).not.toMatch(/^\s+at /m);
    expect(missing.out).not.toContain("Node.js v");

    const usage = run(root, []);
    expect(usage.status).toBe(2);
    expect(usage.out).toContain("사용:");
  });
});

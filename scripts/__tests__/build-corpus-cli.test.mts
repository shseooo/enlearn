/**
 * build-corpus.mts를 명령줄에서 띄웠을 때의 실패 경험을 고정한다 (R6-9).
 *
 * 빌드는 사람이 수동으로 돌리는 도구다. 잘못된 플래그에 스택 트레이스가 나오면
 * 사용자는 어느 인자가 틀렸는지 읽지 못한다. 안내 한 줄 + 사용법으로 끝내야 한다.
 * (테스트가 모듈을 import할 때는 같은 검증이 throw한다 — invokedDirectly가 갈라놓는다.)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const REPO = process.cwd();
const SCRIPT = join(REPO, "scripts", "build-corpus.mts");

const workspaces: string[] = [];

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "enlearn-build-cli-"));
  workspaces.push(root);
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; out: string } {
  const root = workspace();
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: "utf8",
    // 잘못된 인자가 걸러지지 않으면 이 임시 작업 공간에서 빌드가 돈다(네트워크·쓰기).
    env: { ...process.env, ENLEARN_CORPUS_ROOT: root },
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("build-corpus.mts — 잘못된 인자 (R6-9)", () => {
  const badFlags: { args: string[]; expect: string }[] = [
    { args: ["--lane=xyz"], expect: "lane" },
    { args: ["--per-book=0"], expect: "per-book" },
    { args: ["--classic-cap=-5"], expect: "classic-cap" },
  ];

  for (const { args, expect: needle } of badFlags) {
    it(`${args[0]} — 스택 트레이스 대신 안내 한 줄로 끝난다`, () => {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.out, r.out).toContain("빌드 실패:");
      expect(r.out, r.out).toContain(needle);
      expect(r.out).toContain("사용:");
      // Node가 던진 트레이스가 아니라, 사람이 읽는 메시지여야 한다.
      expect(r.out).not.toMatch(/^\s+at /m);
      expect(r.out).not.toContain("Node.js v");
    });
  }
});

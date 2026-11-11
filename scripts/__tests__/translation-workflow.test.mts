/**
 * 사전 번역 도구사슬(dump → merge → audit)의 안전장치를 통째로 확인한다.
 * 1,400문장을 사람 손으로 옮긴 결과이기 때문에, "행이 어긋나면 거부한다"가 실제로
 * 동작하는지 여기서 고정한다. 실제 저장소를 건드리지 않게 임시 디렉터리에서 돌린다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

// vitest는 저장소 루트에서 돌린다. 스크립트 자체는 cwd(임시 작업 공간) 기준으로 움직인다.
const REPO = process.cwd();

/** 일부를 이미 번역한 코퍼스를 가진 임시 작업 공간을 만든다. */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "enlearn-translation-"));
  mkdirSync(join(root, "public", "data", "corpus"), { recursive: true });
  const entries = Array.from({ length: 6 }, (_, i) => ({
    lane: "classic",
    en: `Sentence number ${i}.`,
    ko: i === 0 || i === 2 ? `이미 번역 ${i}.` : null,
    hints: ["walk"],
    difficulty: "normal",
    source: "테스트 책",
    sourceId: String(i),
  }));
  writeFileSync(
    join(root, "public", "data", "corpus", "classics.json"),
    JSON.stringify({
      lane: "classic",
      generatedAt: "2026-01-01T00:00:00.000Z",
      license: "public domain",
      attribution: "테스트",
      sources: [],
      entries,
    }),
  );
  return root;
}

/**
 * 저장소 루트가 아니라 임시 작업 공간 기준으로 스크립트를 실행한다.
 * 경고는 stderr로 나가므로 두 줄을 합쳐 돌려준다. 종료 코드는 status로 확인한다.
 */
function run(root: string, script: string, args: string[] = []): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, [join(REPO, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** 표준 출력만 쓰는 스크립트(dump)는 성공을 전제로 출력만 쓴다. */
function runOk(root: string, script: string, args: string[] = []): string {
  const result = run(root, script, args);
  expect(result.status).toBe(0);
  return result.out;
}

/** 만들고 지운 작업 공간을 추적한다 (실행마다 /tmp에 폴더를 남기지 않는다, 리뷰 1-15) */
const workspaces: string[] = [];

function makeTrackedWorkspace(): string {
  const root = makeWorkspace();
  workspaces.push(root);
  return root;
}

afterAll(() => {
  for (const root of workspaces) rmSync(root, { recursive: true, force: true });
});

describe("사전 번역 도구사슬", () => {
  it("작업 목록은 작업 행 번호와 코퍼스 배열 번호를 갈라서 적는다", () => {
    const root = makeTrackedWorkspace();
    const out = runOk(root, "dump-untranslated.mts");
    expect(out).toContain("작업 목록 4문장");

    const rows = readFileSync(join(root, ".corpus-cache", "worklist.tsv"), "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    // 이미 번역된 0·2번이 빠졌으니, 작업 행 0은 코퍼스 배열 1번을 가리킨다.
    expect(rows.map((r) => [r[0], r[1]])).toEqual([
      ["0", "1"],
      ["1", "3"],
      ["2", "4"],
      ["3", "5"],
    ]);
  });

  it("번역이 필요한 문장이 없으면 기존 작업 목록을 지우지 않는다", () => {
    // 다른 테스트가 만든 작업 목록에 기대지 않고, 같은 작업 공간에서 스스로 채운다.
    const root = makeTrackedWorkspace();
    runOk(root, "dump-untranslated.mts");
    const before = readFileSync(join(root, ".corpus-cache", "worklist.tsv"), "utf8");
    writeFileSync(
      join(root, "public", "data", "corpus", "classics.json"),
      JSON.stringify({
        lane: "classic",
        generatedAt: "2026-01-01T00:00:00.000Z",
        license: "public domain",
        attribution: "테스트",
        sources: [],
        entries: Array.from({ length: 3 }, (_, i) => ({
          lane: "classic",
          en: `Sentence number ${i}.`,
          ko: `이미 번역 ${i}.`,
          hints: [],
          difficulty: "normal",
          source: "테스트 책",
        })),
      }),
    );
    const out = runOk(root, "dump-untranslated.mts");
    expect(out).toContain("작업 목록은 그대로 둡니다");
    expect(readFileSync(join(root, ".corpus-cache", "worklist.tsv"), "utf8")).toBe(before);
  });

  it("행 번호가 어긋난 원고는 파일 전체를 거부한다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "bad.txt"),
      "0\t첫 번째 문장입니다.\n0\t또 첫 번째 문장입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [".corpus-cache/ko/bad.txt#0"]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("순서가 어긋났으므로 파일을 통째로 거부합니다");
  });

  it("원고에 다른 언어 문자가 섞이면 경고를 내놓는다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "dirty.txt"),
      "0\t문장에 TV가 섞였다 C20\n1\t순수 english만\n",
    );
    const out = runOk(workspace, "merge-translations.mts", [".corpus-cache/ko/dirty.txt#0"]);
    expect(out).toContain("다른 언어 문자가 섞였습니다 [TV | C20]");
  });

  it("코퍼스 파일에 아직 반영되지 않은 번역은 빌드 미반영으로 알린다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "good.txt"),
      "0\t첫 문장입니다.\n1\t세 문장입니다.\n2\t네 문장입니다.\n3\t다섯 문장입니다.\n",
    );
    runOk(workspace, "merge-translations.mts", [".corpus-cache/ko/good.txt#0"]);
    const audit = run(workspace, "audit-translations.mts");
    // 코퍼스 파일에는 아직 한국어가 없으므로 감사는 실패로 끝나야 한다.
    expect(audit.status).toBe(1);
    expect(audit.out).toContain("빌드 미반영 4");
  });
});

/**
 * 사전 번역 도구사슬(dump → merge → audit)의 안전장치를 통째로 확인한다.
 * 1,400문장을 사람 손으로 옮긴 결과이기 때문에, "행이 어긋나면 거부한다"가 실제로
 * 동작하는지 여기서 고정한다. 실제 저장소를 건드리지 않게 임시 디렉터리에서 돌린다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { normalizeKey } from "../../src/lib/corpus-tools.ts";

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

/** 코퍼스 파일 하나 없는 빈 작업 공간 (README가 안내하는 첫 명령의 실패 경로) */
function makeEmptyWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "enlearn-translation-empty-"));
  mkdirSync(join(root, "public", "data", "corpus"), { recursive: true });
  return root;
}

/** 만들고 지운 작업 공간을 추적한다 (실행마다 /tmp에 폴더를 남기지 않는다, 리뷰 1-15) */
const workspaces: string[] = [];

function makeTrackedWorkspace(factory: () => string = makeWorkspace): string {
  const root = factory();
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

  // D3-2(R6-4): merge가 원문과 대조할 수 있게, dump는 원문 앞부분을 담은 원고 틀도 뽑는다.
  it("dump는 원문 앞부분을 담은 빈 원고 틀도 만든다 (D3-2)", () => {
    const root = makeTrackedWorkspace();
    const out = runOk(root, "dump-untranslated.mts");
    expect(out).toContain("manuscript.tsv");

    const rows = readFileSync(join(root, ".corpus-cache", "manuscript.tsv"), "utf8")
      .replace(/\r?\n$/, "")
      .split("\n")
      .map((line) => line.split("\t"));
    expect(rows).toEqual([
      ["0", "Sentence number 1.", ""],
      ["1", "Sentence number 3.", ""],
      ["2", "Sentence number 4.", ""],
      ["3", "Sentence number 5.", ""],
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

  it("코퍼스 파일이 없으면 dump는 한국어 안내로 끝난다 — 스택 트레이스 아님 (리뷰 4-2)", () => {
    const root = makeTrackedWorkspace(makeEmptyWorkspace);
    const r = run(root, "dump-untranslated.mts");
    expect(r.status).toBe(1);
    expect(r.out).toContain("코퍼스 파일을 찾을 수 없습니다");
    expect(r.out).toContain("npm run corpus");
    expect(r.out).not.toMatch(/^\s+at /m);
    expect(r.out).not.toContain("Node.js v");
    expect(existsSync(join(root, ".corpus-cache", "worklist.tsv"))).toBe(false);
  });

  it("entries가 없는 코퍼스 파일도 dump는 안내로 거부한다 (리뷰 4-2)", () => {
    const root = makeTrackedWorkspace(makeEmptyWorkspace);
    writeFileSync(
      join(root, "public", "data", "corpus", "classics.json"),
      '{"lane":"classic","generatedAt":"x"}',
    );
    const r = run(root, "dump-untranslated.mts");
    expect(r.status).toBe(1);
    expect(r.out).toContain('"entries" 배열이 필요합니다');
    expect(r.out).not.toMatch(/TypeError/);
    expect(r.out).not.toMatch(/^\s+at /m);
  });

  it("코퍼스 JSON이 잘려 있으면 해석 실패를 안내한다 (리뷰 4-2)", () => {
    const root = makeTrackedWorkspace(makeEmptyWorkspace);
    writeFileSync(join(root, "public", "data", "corpus", "classics.json"), '{"entries": [');
    const r = run(root, "dump-untranslated.mts");
    expect(r.status).toBe(1);
    expect(r.out).toContain("코퍼스 JSON을 해석할 수 없습니다");
    expect(r.out).not.toMatch(/^\s+at /m);
  });

  it("원고 경로 오타는 merge를 안내로 끝내고 캐시를 만들지 않는다 (리뷰 4-2)", () => {
    const root = makeTrackedWorkspace();
    runOk(root, "dump-untranslated.mts");
    const r = run(root, "merge-translations.mts", ["missing.txt#0"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("파일을 찾을 수 없습니다: missing.txt");
    expect(r.out).toContain(".corpus-cache/ko/");
    expect(r.out).not.toMatch(/^\s+at /m);
    expect(existsSync(join(root, ".corpus-cache", "translations.json"))).toBe(false);
  });

  it("작업 목록은 원자적으로 쓰인다 (리뷰 4-1)", () => {
    const root = makeTrackedWorkspace();
    runOk(root, "dump-untranslated.mts");
    const files = readdirSync(join(root, ".corpus-cache")).filter((n) => n.endsWith(".tmp"));
    expect(files).toEqual([]);
  });

  it("행 번호가 어긋난 원고는 파일 전체를 거부한다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "bad.txt"),
      "0\tSentence number 1.\t첫 번째 문장입니다.\n0\tSentence number 1.\t또 첫 번째 문장입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [".corpus-cache/ko/bad.txt#0"]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("순서가 어긋났으므로 파일을 통째로 거부합니다");
  });

  it("번호 없는 원고는 거부한다 — 빈 줄 한 개가 순서를 미는 것을 잡는다 (리뷰 3-2)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    // worklist 3행의 중간 빈 줄 하나: 번호가 없으면 순서가 밀려도 모른다.
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "plain.txt"),
      "첫 문장 번역입니다.\n\n세 번째 문장 번역입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/plain.txt#0",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("worklist 행 번호");
    // 거부된 원고는 캐시에 한 항목도 남기지 않는다
    expect(existsSync(join(workspace, ".corpus-cache", "translations.json"))).toBe(false);

    // 탭 대신 공백을 쓴 줄도 같은 경로(번호 없음)로 거부된다
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "spaced.txt"),
      "0 첫 문장 번역입니다.\n",
    );
    const spaced = run(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/spaced.txt#0",
    ]);
    expect(spaced.status).toBe(1);
    expect(spaced.out).toContain("worklist 행 번호");
  });

  it("원고에 다른 언어 문자가 섞이면 경고를 내놓는다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "dirty.txt"),
      "0\tSentence number 1.\t문장에 TV가 섞였다 C20\n1\tSentence number 3.\t순수 english만\n",
    );
    const out = runOk(workspace, "merge-translations.mts", [".corpus-cache/ko/dirty.txt#0"]);
    expect(out).toContain("다른 언어 문자가 섞였습니다 [TV | C20]");
  });

  it("merge와 check-translations는 같은 한글 판정을 쓴다 (리뷰 2-11)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    // 자모만 있는 원고: 공통 hasHangul은 한국어로 본다.
    // merge가 자체적으로 쓰던 [가-힣] 정규식에서는 여기서만 "한글 없음"으로 걸러졌다.
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "jamo.txt"),
      "0\tSentence number 1.\t\u3131\u314f\u3137\u3142\n",
    );

    const check = runOk(workspace, "check-translations.mts", [
      ".corpus-cache/ko/jamo.txt",
    ]);
    expect(check).toContain("문제 0건");

    const merged = runOk(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/jamo.txt#0",
    ]);
    expect(merged).not.toContain("건넙니다(한글 없음)");
    const cache = JSON.parse(
      readFileSync(join(workspace, ".corpus-cache", "translations.json"), "utf8"),
    ) as Record<string, { ko: string }>;
    expect(cache[normalizeKey("Sentence number 1.")]?.ko).toBe("\u3131\u314f\u3137\u3142");
  });

  it("코퍼스 파일에 아직 반영되지 않은 번역은 빌드 미반영으로 알린다", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "good.txt"),
      "0\tSentence number 1.\t첫 문장입니다.\n1\tSentence number 3.\t세 문장입니다.\n2\tSentence number 4.\t네 문장입니다.\n3\tSentence number 5.\t다섯 문장입니다.\n",
    );
    runOk(workspace, "merge-translations.mts", [".corpus-cache/ko/good.txt#0"]);
    const audit = run(workspace, "audit-translations.mts");
    // 코퍼스 파일에는 아직 한국어가 없으므로 감사는 실패로 끝나야 한다.
    expect(audit.status).toBe(1);
    expect(audit.out).toContain("빌드 미반영 4");
  });

  /*
   * D3-2(R6-4): 원고 검증이 "번호가 연속인지"만 보니, 두 줄을 맞바꾸거나 순서를
   * 다시 써도(번호는 여전히 연속) 모든 번역이 엉뚱한 문장에 붙어 코퍼스에 남는다.
   * 원고의 "원문 앞부분" 컬럼을 worklist와 대조해 그 자리를 막는다.
   */
  it("원문 앞부분이 worklist와 다른 줄은 파일 통째로 거부한다 (D3-2)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    // 번호는 연속적이지만 0·1행의 원문 앞부분이 서로 바뀌었다.
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "swapped.txt"),
      "0\tSentence number 3.\t첫 문장 번역입니다.\n1\tSentence number 1.\t세 문장 번역입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/swapped.txt#0",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("원문 앞부분이 worklist와 다릅니다");
    // 거부된 원고는 캐시에 한 항목도 남기지 않는다
    expect(existsSync(join(workspace, ".corpus-cache", "translations.json"))).toBe(false);
  });

  it("두 칸짜리 옛 형식 원고는 거부한다 (D3-2 — 호환 없음)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "legacy.txt"),
      "0\t첫 문장 번역입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/legacy.txt#0",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("세 칸입니다");
    expect(existsSync(join(workspace, ".corpus-cache", "translations.json"))).toBe(false);
  });

  it("원문 앞부분을 짧게 줄여 써도 같은 문장이면 받아들인다 (접두어 대조)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "short.txt"),
      "0\tS\t첫 문장 번역입니다.\n",
    );
    const rejected = run(workspace, "merge-translations.mts", [
      ".corpus-cache/ko/short.txt#0",
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.out).toContain("원문 앞부분이 worklist와 다릅니다");

    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "ok.txt"),
      "0\tSentence num\t첫 문장 번역입니다.\n",
    );
    const ok = runOk(workspace, "merge-translations.mts", [".corpus-cache/ko/ok.txt#0"]);
    expect(ok).toContain("캐시 합침");
  });

  // R6-9: 손상된 번역 캐시를 합칠 때 스택 트레이스가 아니라 안내 한 줄로 끝나야 한다.
  it("손상된 번역 캐시를 합치려 하면 안내 한 줄로 끝난다 (R6-9)", () => {
    const workspace = makeTrackedWorkspace();
    run(workspace, "dump-untranslated.mts");
    mkdirSync(join(workspace, ".corpus-cache", "ko"), { recursive: true });
    mkdirSync(join(workspace, ".corpus-cache"), { recursive: true });
    writeFileSync(join(workspace, ".corpus-cache", "translations.json"), "{ 깨진 캐시");
    writeFileSync(
      join(workspace, ".corpus-cache", "ko", "any.txt"),
      "0\tSentence number 1.\t첫 문장 번역입니다.\n",
    );
    const r = run(workspace, "merge-translations.mts", [".corpus-cache/ko/any.txt#0"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("원고를 합치지 못했습니다");
    expect(r.out).toContain("손상되었습니다");
    expect(r.out).not.toMatch(/^\s+at /m);
    expect(r.out).not.toContain("Node.js v");
  });
});

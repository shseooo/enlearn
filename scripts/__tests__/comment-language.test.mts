/**
 * 주석에 다른 언어가 섞여 들어오는 것을 막는다(R7-13).
 *
 * 커밋 383a9c8("채점 프롬프트 주석에 섞인 일본어 조각을 지운다")가 같은 증상을 고친 이력이
 * 있다. 사람이 읽는 근거가 "사실을 말하지 않는" 주석이 되돌아오면 리뷰·수정마다 다시 잡아야 한다.
 *
 * ⚠️ 이 테스트가 잡는 것은 주석 속 일본어 가나(히라가나·가타카나·반각 가나)다.
 *    테스트 코드 안의 검사 표본 문자열(외국어 섞임 감지 테스트가 쓰는 문장들)은
 *    검사하지 않는다 — 검사 대상은 주석만이다. 한글 주석에 섞이는 영어 단어
 *    (예: "clip으로 Already 자르지만")는 식별자·용어와 구분할 기준이 없어
 *    자동 검사로 두지 않았다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const REPO = process.cwd();
const ROOTS = ["src", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

/** 히라가나 · 가타카나 · 반각 가나 */
const KANA = /[\u3040-\u30ff\uff66-\uff9f]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

/**
 * 문자열 리터럴을 건너뛰면서 주석 조각만 뽑는다.
 * 줄 주석과 블록 주석을 한 번에 훑고, 반환값에는 "무슨 글자가 있었는지"만 남긴다
 * (줄 번호 보고를 위해 원문을 그대로 쓴다).
 */
function commentsOf(text: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let i = 0;
  let line = 1;
  let quote = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (quote) {
      // 문자열 안: 종료 인용부호(또는 줄 끝)까지 건너뛴다.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const start = i;
      const startLine = line;
      while (i < text.length && text[i] !== "\n") i++;
      found.push({ line: startLine, text: text.slice(start, i) });
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const startLine = line;
      i += 2;
      const start = i;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      found.push({ line: startLine, text: text.slice(start, i) });
      i += 2;
      continue;
    }
    i++;
  }
  return found;
}

describe("주석에 섞인 비한자·비영어 문자 (R7-13)", () => {
  it("src·scripts 주석에 일본어 가나가 들어있지 않다", () => {
    const offenders: string[] = [];
    let checked = 0;

    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO, root))) {
        const text = readFileSync(file, "utf8");
        for (const comment of commentsOf(text)) {
          checked++;
          if (KANA.test(comment.text)) {
            offenders.push(`${relative(REPO, file)}:${comment.line}: ${comment.text.trim().slice(0, 80)}`);
          }
        }
      }
    }

    // 검사 자체가 빈 집합이면 의미가 없다 — 실제로 주석을 훑고 있음을 확인한다.
    expect(checked).toBeGreaterThan(500);
    expect(offenders, "주석에 일본어 가나가 섞였습니다(커밋 383a9c8의 증상).").toEqual([]);
  });
});

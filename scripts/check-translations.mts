/**
 * 번역 원고 파일의 언어 오염을 검사한다.
 *
 * 원고 형식(D3-2 — merge-translations.mts와 같다. 옛 두 칸 형식은 받지 않는다):
 *   <worklist 행 번호>\t<원문 앞부분>\t<번역>
 *   505\tThe Rabbit thought about it for a whi\t두꺼비는 그냥 마음을 놓았다.
 * 앞의 두 컬럼(번호·원문 앞부분)은 검사하지 않는다 — 원문 앞부분은 영어라서
 * 그대로 검사하면 모든 줄이 "외국어 문자"로 잡힌다(R6-4).
 *
 * 검사 항목
 *  - 한글이 아닌 문자가 섞였는지 (라틴·일본 가나·중일한자·키릴·태국 문자 등)
 *  - 아예 한글이 없는 줄은 아닌지
 *  - 원고 형식(세 컬럼)을 지키는지 — merge가 같은 이유로 파일을 통째로 거부하기 전에 잡는다
 *
 * 허용 목록은 scripts/lib/foreign-text.ts의 기준 목록 하나를 쓰고, `--allow=`는 거기에 더한다(D4-3).
 *
 * 사용:
 *   node scripts/check-translations.mts ko/chunk-0500.txt ko/chunk-0600.txt
 *   node scripts/check-translations.mts --allow=DVR ko/chunk-0500.txt
 * 파일 경로는 현재 위치 또는 .corpus-cache/ 아래에서 찾는다.
 * 종료 코드: 문제 없으면 0, 문제 있으면 1 (CI에서 Gate로 쓸 수 있게)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { allowedLatinSet, foreignLetterRuns, hasHangul } from "./lib/foreign-text.ts";

/** 인자를 현재 위치 또는 .corpus-cache/ 아래에서 찾는다. */
function locate(path: string): string {
  for (const candidate of [resolve(path), resolve(".corpus-cache", path)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`파일을 찾을 수 없습니다: ${path}`);
}

function parseArgs(argv: string[]): { files: string[]; allowed: Set<string> } {
  const files: string[] = [];
  const extra: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--allow=")) {
      for (const word of arg.slice("--allow=".length).split(",")) {
        if (word) extra.push(word);
      }
    } else {
      files.push(arg);
    }
  }
  // 기준 목록(D4-3)에 --allow를 더한다.
  return { files, allowed: allowedLatinSet(extra) };
}

/** 앞의 "<행번호>\t<원문 앞부분>\t" 접두사를 벗긴다. 컬럼 수(원고 형식 확인용)도 함께 준다. */
function splitManuscriptLine(line: string): { columns: number; ko: string } {
  const columns = line.split("\t");
  if (columns.length >= 3 && /^\d+$/.test(columns[0])) {
    return { columns: columns.length, ko: columns.slice(2).join("\t") };
  }
  return { columns: columns.length, ko: line };
}

const { files, allowed } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error("사용: node scripts/check-translations.mts [--allow=허용단어] 파일...");
  process.exit(2);
}

let checkedLines = 0;
let problems = 0;

for (const file of files) {
  // locate()는 파일을 못 찾으면 던진다. 안내 한 줄로 끝내야 스택 트레이스를 보지 않는다(R6-9).
  let text: string;
  try {
    text = readFileSync(locate(file), "utf8");
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  // 원본 줄을 유지한 채 순회한다. 빈 줄을 지운 뒤 인덱스를 파일 줄 번호로 쓰면
  // 이 스크립트가 짚어주는 위치가 실제 줄과 어긋난다(리뷰 3-5).
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    checkedLines++;
    const { columns, ko } = splitManuscriptLine(line);
    const foreign = foreignLetterRuns(ko, allowed);
    const where = `${file}:${index + 1}`;
    if (columns < 3 || !/^\d+$/.test(line.split("\t")[0])) {
      // merge가 같은 이유로 파일을 통째로 거부한다 — 여기서 먼저 짚어 주는 편이 낫다.
      problems++;
      console.log(
        `${where} 원고 형식: <번호>\\t<원문 앞부분>\\t<번역> 세 컬럼이 필요합니다 :: ${line.slice(0, 90)}`,
      );
    } else if (foreign.length > 0) {
      problems++;
      console.log(`${where} 외국어 문자 [${foreign.join(" | ")}] :: ${line.slice(0, 90)}`);
    } else if (!hasHangul(ko)) {
      problems++;
      console.log(`${where} 한글 없음 :: ${line.slice(0, 90)}`);
    }
  });
}

console.log(`검사 완료: 파일 ${files.length}개 / 줄 ${checkedLines}개 / 문제 ${problems}건`);
process.exit(problems > 0 ? 1 : 0);

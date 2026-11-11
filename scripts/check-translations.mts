/**
 * 번역 원고 파일의 언어 오염을 검사한다.
 *
 * 원고 형식: 한 줄에 한 문장. worklist 행 번호를 붙여 쓰면 그 부분(번호 + 탭)은 검사하지 않는다.
 *   505\t두꺼비는 그냥 마음을 놓았다.
 *
 * 검사 항목
 *  - 한글이 아닌 문자가 섞였는지 (라틴·일본 가나·중일한자·키릴·태국 문자 등)
 *  - 아예 한글이 없는 줄은 아닌지
 *
 * 사용:
 *   node scripts/check-translations.mts ko/chunk-0500.txt ko/chunk-0600.txt
 *   node scripts/check-translations.mts --allow=TV,DNA ko/chunk-0500.txt
 * 파일 경로는 현재 위치 또는 .corpus-cache/ 아래에서 찾는다.
 * 종료 코드: 문제 없으면 0, 문제 있으면 1 (CI에서 Gate로 쓸 수 있게)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { foreignLetterRuns, hasHangul } from "./lib/foreign-text.ts";

/** 인자를 현재 위치 또는 .corpus-cache/ 아래에서 찾는다. */
function locate(path: string): string {
  for (const candidate of [resolve(path), resolve(".corpus-cache", path)]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`파일을 찾을 수 없습니다: ${path}`);
}

function parseArgs(argv: string[]): { files: string[]; allowed: Set<string> } {
  const files: string[] = [];
  const allowed = new Set<string>();
  for (const arg of argv) {
    if (arg.startsWith("--allow=")) {
      for (const word of arg.slice("--allow=".length).split(",")) {
        if (word) allowed.add(word);
      }
    } else {
      files.push(arg);
    }
  }
  return { files, allowed };
}

/** 앞의 "<행번호>\t" 접두사를 벗긴다. */
function translationOf(line: string): string {
  return line.includes("\t") ? line.split("\t").slice(1).join("\t") : line;
}

const { files, allowed } = parseArgs(process.argv.slice(2));
if (files.length === 0) {
  console.error("사용: node scripts/check-translations.mts [--allow=허용단어] 파일...");
  process.exit(2);
}

let checkedLines = 0;
let problems = 0;

for (const file of files) {
  // 원본 줄을 유지한 채 순회한다. 빈 줄을 지운 뒤 인덱스를 파일 줄 번호로 쓰면
  // 이 스크립트가 짚어주는 위치가 실제 줄과 어긋난다(리뷰 3-5).
  readFileSync(locate(file), "utf8")
    .split("\n")
    .forEach((raw, index) => {
      const line = raw.trim();
      if (!line) return;
      checkedLines++;
      const ko = translationOf(line);
      const foreign = foreignLetterRuns(ko, allowed);
      const where = `${file}:${index + 1}`;
      if (foreign.length > 0) {
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

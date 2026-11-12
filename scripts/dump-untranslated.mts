/**
 * 한국어가 비어 있는 동화 문장을 번역 작업 목록 + 빈 원고 틀로 뽑는다.
 *
 * LLM 없이 번역을 넣을 때의 시작점이다. 만든 원고를 100문장씩 나눠 번역한 뒤
 * merge-translations.mts로 캐시에 합치면, 빌더는 요청 없이 그 번역으로 코퍼스를 채운다.
 *
 * 사용: node scripts/dump-untranslated.mts (번역이 필요한 문장이 없으면 기존 작업 목록을 지우지 않는다)
 *
 * 출력 1: .corpus-cache/worklist.tsv — 한 줄에
 *   <작업 행 번호(0-based)><TAB><코퍼스 배열 번호><TAB><영어 원문>
 * 출력 2: .corpus-cache/manuscript.tsv — 사람이 채우는 원고 틀 (D3-2)
 *   <작업 행 번호(0-based)><TAB><원문 앞부분(최대 40자)><TAB><빈 번역>
 *
 * 두 번호를 구분해서 쓴다. 원고 각 줄 앞에 적는 번호는 **작업 행 번호**이고,
 * classics.json 배열 번호는 이미 번역된 문장이 섞일 때 앞으로 밀린다(감사·추적용).
 * 원고의 원문 앞부분 컬럼은 merge가 worklist와 대조한다 — 두 줄을 맞바꾸면
 * 모든 번역이 엉뚱한 문장에 붙고 그대로 코퍼스에 남는다(R6-4).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusFile } from "../src/lib/types.ts";

import { writeAtomic } from "./lib/json-file.ts";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".corpus-cache");
const WORKLIST_FILE = join(CACHE_DIR, "worklist.tsv");
const MANUSCRIPT_FILE = join(CACHE_DIR, "manuscript.tsv");
const CORPUS_FILE = join(ROOT, "public", "data", "corpus", "classics.json");

/** 원고의 "원문 앞부분" 컬럼 길이 (worklist의 en 접두어) */
export const MANUSCRIPT_PREFIX_CHARS = 40;

/**
 * 코퍼스를 읽는다. 크래시 말고 한국어 안내 + exit 1로 끝난다(audit와 같은 계약, R4-2).
 * README가 사람에게 처음 실행하라고 안내하는 명령이 dump이므로, 여기서 스택 트레이스를
 * 보여서는 안 된다.
 */
function readCorpus(): CorpusFile {
  if (!existsSync(CORPUS_FILE)) {
    console.error(
      `코퍼스 파일을 찾을 수 없습니다: public/data/corpus/classics.json — ` +
        `먼저 npm run corpus -- --lane=classic --offline 으로 코퍼스를 만드세요. (${CORPUS_FILE})`,
    );
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CORPUS_FILE, "utf8"));
  } catch (e) {
    console.error(
      `코퍼스 JSON을 해석할 수 없습니다: ${CORPUS_FILE} — ` +
        `파일이 잘렸을 수 있습니다. npm run corpus -- --lane=classic --offline 으로 다시 만드세요. ` +
        `(${e instanceof Error ? e.message : e})`,
    );
    process.exit(1);
  }
  // entries가 없는 파일(예: 빈 객체)은 아래 .map에서 TypeError로 터진다(R3-3과 같은 마무리 부족).
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as CorpusFile).entries)) {
    console.error(
      `코퍼스 파일 형식이 올바르지 않습니다: ${CORPUS_FILE} — "entries" 배열이 필요합니다. ` +
        `npm run corpus -- --lane=classic --offline 으로 다시 만드세요.`,
    );
    process.exit(1);
  }
  return parsed as CorpusFile;
}

function main(): void {
  const corpus = readCorpus();

  const pending = corpus.entries
    .map((entry, entryIndex) => ({ entry, entryIndex }))
    .filter(({ entry }) => !entry.ko);

  if (pending.length === 0) {
    console.log("번역이 필요한 문장이 없습니다. 작업 목록은 그대로 둡니다.");
    return;
  }

  const rows = pending.map(
    ({ entry, entryIndex }, worklistRow) =>
      `${worklistRow}\t${entryIndex}\t${entry.en}`,
  );
  // 사람이 채우는 원고 틀 (D3-2): 번호·원문 앞부분·빈 번역.
  const manuscripts = pending.map(
    ({ entry }, worklistRow) =>
      `${worklistRow}\t${entry.en.slice(0, MANUSCRIPT_PREFIX_CHARS)}\t`,
  );

  mkdirSync(CACHE_DIR, { recursive: true });
  // 제자리 덮어쓰기가 죽으면 잘린 작업 목록이 남고, 그 줄 번호로 원고가 쓰인다(R4-1).
  writeAtomic(WORKLIST_FILE, rows.join("\n") + "\n");
  writeAtomic(MANUSCRIPT_FILE, manuscripts.join("\n") + "\n");
  console.log(`작업 목록 ${rows.length}문장 → .corpus-cache/worklist.tsv`);
  console.log(`원고 틀 ${manuscripts.length}문장 → .corpus-cache/manuscript.tsv (세 번째 칸에 번역을 적으세요)`);
}

try {
  main();
} catch (e) {
  // 예상 밖 오류도 한 줄 안내로 끝낸다(R4-2).
  console.error(`작업 목록을 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

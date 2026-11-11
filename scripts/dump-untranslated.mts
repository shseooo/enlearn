/**
 * 한국어가 비어 있는 동화 문장을 번역 작업 목록으로 뽑는다.
 *
 * LLM 없이 번역을 넣을 때의 시작점이다. 만든 작업 목록을 100문장씩 나눠 번역한 뒤
 * merge-translations.mts로 캐시에 합치면, 빌더는 요청 없이 그 번역으로 코퍼스를 채운다.
 *
 * 사용: node scripts/dump-untranslated.mts (번역이 필요한 문장이 없으면 기존 작업 목록을 지우지 않는다)
 *
 * 출력: .corpus-cache/worklist.tsv — 한 줄에
 *   <작업 행 번호(0-based)><TAB><classics.json 배열 번호><TAB><영어 원문>
 *
 * 두 번호를 구분해서 쓴다. 원고 각 줄 앞에 적는 번호는 **작업 행 번호**이고,
 * classics.json 배열 번호는 이미 번역된 문장이 섞일 때 앞으로 밀린다(감사·추적용).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusFile } from "../src/lib/types.ts";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".corpus-cache");
const WORKLIST_FILE = join(CACHE_DIR, "worklist.tsv");
const CORPUS_FILE = join(ROOT, "public", "data", "corpus", "classics.json");

const corpus = JSON.parse(readFileSync(CORPUS_FILE, "utf8")) as CorpusFile;

const rows = corpus.entries
  .map((entry, entryIndex) => ({ entry, entryIndex }))
  .filter(({ entry }) => !entry.ko)
  .map(({ entry, entryIndex }, worklistRow) => `${worklistRow}\t${entryIndex}\t${entry.en}`);

if (rows.length === 0) {
  console.log("번역이 필요한 문장이 없습니다. 작업 목록은 그대로 둡니다.");
  process.exit(0);
}

mkdirSync(CACHE_DIR, { recursive: true });
writeFileSync(WORKLIST_FILE, rows.join("\n") + "\n");
console.log(`작업 목록 ${rows.length}문장 → .corpus-cache/worklist.tsv`);

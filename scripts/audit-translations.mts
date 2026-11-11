/**
 * 사전 번역 결과와 동화 코퍼스를 감사한다. (번역 원고를 캐시에 합친 뒤 마지막 확인)
 *
 * 본다:
 *  - 누역: 수록된 문장인데 한국어가 없는 경우
 *  - 빌드 미반영: 번역 캐시에는 있는데 코퍼스 파일에 아직 없는 경우 (빌드를 다시 돌려야 한다)
 *  - 언어 오염: 한국어에 라틴·일본 가나·중일한자·키릴 등 다른 언어 문자가 섞인 경우
 *  - 모양: 지나치게 짧거나 길거나 문장 부호로 끝나지 않는 경우 (경고만 한다)
 *  - 중복 번역: 같은 한국어가 서로 다른 두 문장에 붙은 경우 — worklist 행이 어긋난 신호다
 *
 * 사용: node scripts/audit-translations.mts
 * 종료 코드: 누역·빌드 미반영·언어 오염이 있으면 1. 모양 경고와 중복은 경고만 출력하고 0으로 끝난다
 * ( 모양은 원문에 따라 정상이 있을 수 있어 판단을 사람에게 맡긴다.)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { CorpusEntry } from "../src/lib/types.ts";

import { foreignLetterRuns, hasHangul } from "./lib/foreign-text.ts";
// 번역 캐시의 키 규칙은 빌더와 반드시 같아야 하므로, 같은 normalizeKey를 import한다.
import { normalizeKey } from "../src/lib/corpus-tools.ts";

const ROOT = process.cwd();
const CORPUS_FILE = join(ROOT, "public", "data", "corpus", "classics.json");
const CACHE_FILE = join(ROOT, ".corpus-cache", "translations.json");

type TranslationCache = Record<string, { ko?: string }>;

/** 최소·최대 길이. 원문이 두 문장이 이어진 경우를 감안해 위쪽은 넉넉하게 둔다. */
const MIN_KO_CHARS = 6;
const MAX_KO_CHARS = 140;

function readJson<T>(path: string, hint: string): T {
  if (!existsSync(path)) {
    console.error(`파일이 없습니다: ${path}\n${hint}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    console.error(`JSON을 읽을 수 없습니다: ${path}`);
    process.exit(1);
  }
}

const corpus = readJson<{ entries: CorpusEntry[] }>(
  CORPUS_FILE,
  "먼저 npm run corpus -- --lane=classic --offline 으로 코퍼스를 만드세요.",
);
// entries가 없는 파일을 넘기면 아래 반복이 TypeError로 터져, 사용자는 한국어 안내 대신
// 스택 트레이스를 본다(R2-6에서 고친 것과 같은 종류의 마무리 부족, 리뷰 3-3).
if (typeof corpus !== "object" || corpus === null || !Array.isArray(corpus.entries)) {
  console.error(
    `코퍼스 파일 형식이 올바르지 않습니다: ${CORPUS_FILE} — "entries" 배열이 필요합니다. ` +
      `npm run corpus -- --lane=classic --offline 으로 다시 만드세요.`,
  );
  process.exit(1);
}
// 0문장 코퍼스는 "검사할 게 없다"가 아니라 코퍼스가 비었다는 신호다.
// 사람 손으로 옮긴 번역이 들어 있던 자리를 빈 파일이 덮은 경우가 이 경로로 들어온다(리뷰 3-1).
if (corpus.entries.length === 0) {
  console.error(
    `코퍼스에 문장이 없습니다: ${CORPUS_FILE} — 0문장으로는 감사를 통과시킬 수 없습니다. ` +
      `코퍼스 빌드가 원본을 받지 못한 채 기존 파일을 덮었는지 확인하세요.`,
  );
  process.exit(1);
}
const cache = readJson<TranslationCache>(
  CACHE_FILE,
  "번역 캐시가 없습니다. node scripts/merge-translations.mts 로 원고를 합친 뒤 다시 실행하세요.",
);

let missing = 0;
let notBuilt = 0;
let contaminated = 0;
let shapeWarnings = 0;
const duplicates: string[] = [];
const seenKo = new Map<string, string>(); // 번역 → 처음 본 원문

for (const entry of corpus.entries) {
  // 감사 대상은 커밋된 코퍼스 파일이다. 캐시 값으로 판정을 대체하면 파일이 옛날 상태여도 통과한다.
  const cached = cache[normalizeKey(entry.en)]?.ko;
  const ko = entry.ko ?? "";

  if (!ko.trim() && cached?.trim()) {
    notBuilt++;
    console.log(`빌드 미반영(캐시에는 있음): ${entry.en.slice(0, 70)}`);
    continue;
  }

  if (!ko.trim()) {
    missing++;
    console.log(`누역: ${entry.en.slice(0, 70)}`);
    continue;
  }

  const foreign = foreignLetterRuns(ko);
  if (foreign.length > 0 || !hasHangul(ko)) {
    contaminated++;
    console.log(`언어 오염 [${foreign.join(" | ")}]: ${ko.slice(0, 80)}`);
  }

  const chars = [...ko].length;
  if (chars < MIN_KO_CHARS || chars > MAX_KO_CHARS || !/[.!?"»’]$/.test(ko.trim())) {
    shapeWarnings++;
    console.log(`모양 경고(${chars}자): ${ko.slice(0, 80)}`);
  }

  const previousEn = seenKo.get(ko);
  if (previousEn && previousEn !== entry.en) {
    duplicates.push(`${ko.slice(0, 40)} ← ${entry.en.slice(0, 40)} / ${previousEn.slice(0, 40)}`);
  }
  seenKo.set(ko, entry.en);
}

console.log(
  `코퍼스 ${corpus.entries.length}문장 · 누역 ${missing} · 빌드 미반영 ${notBuilt} · ` +
    `언어 오염 ${contaminated} · 모양 경고 ${shapeWarnings} · 중복 번역 ${duplicates.length}`,
);
for (const duplicate of duplicates.slice(0, 20)) console.log(`중복: ${duplicate}`);

if (missing === 0 && notBuilt === 0 && contaminated === 0) {
  console.log("감사 통과");
}
process.exit(missing > 0 || notBuilt > 0 || contaminated > 0 ? 1 : 0);

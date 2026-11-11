/**
 * 사람이(또는 모델이) 직접 번역한 원고를 번역 캐시에 합친다.
 *
 * 캐시(.corpus-cache/translations.json)의 키는 빌더와 같은 normalizeKey(en) 규약이다.
 * 따라서 캐시를 채워 두면 다음 빌드는 LLM 요청을 하나도 보내지 않고 이 번역을 그대로 쓴다.
 *   ENLEARN_LLM_HOST=... npm run corpus -- --lane=classic --offline --llm
 *
 * 원고 형식
 *  - 한 줄에 한 문장, worklist와 같은 순서.
 *  - 각 줄 앞에 worklist 행 번호와 탭을 붙인다 → 병합할 때 번호로 대응을 확인한다.
 *      505\t두꺼비는 그냥 마음을 놓았다.
 *    번호가 한 줄이라도 어긋나면 파일 전체를 거부한다(순서가 밀리면 모든 번역이 엉뚱한 문장에 붙는다).
 *  - 파일 인자에는 시작 위치를 붙인다: <파일>#<worklist 시작 행(0-based)>
 *
 * 사용:
 *   node scripts/merge-translations.mts .corpus-cache/ko/chunk-0001a.txt#0 \
 *                                       .corpus-cache/ko/chunk-0001b.txt#50
 *
 * 캐시 항목의 hints는 항상 빈 배열로 쓴다. 힌트는 빌더가 코퍼스 어휘 빈도로 계산하며,
 * 캐시에 힌트가 들어 있으면 그 값을 우선하기 때문이다.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeKey } from "../src/lib/corpus-tools.ts";

import { foreignLetterRuns, hasHangul } from "./lib/foreign-text.ts";
import { readJsonCache, writeJsonAtomically } from "./lib/json-file.ts";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".corpus-cache");
const CACHE_FILE = join(CACHE_DIR, "translations.json");
const WORKLIST_FILE = join(CACHE_DIR, "worklist.tsv");

type CacheEntry = { ko: string; hints: string[] };
type WorklistRow = { index: number; en: string };

/**
 * worklist.tsv: "<작업 행 번호(0-based)><TAB>[<코퍼스 배열 번호><TAB>]<원문>"
 * 첫 열은 원고 각 줄에 적는 번호이고, 원문은 마지막 열이다. 열이 두 개면 옛 형식으로 본다.
 */
function readWorklist(): WorklistRow[] {
  if (!existsSync(WORKLIST_FILE)) {
    console.error(
      "worklist.tsv가 없습니다. 먼저 node scripts/dump-untranslated.mts 를 실행하세요.",
    );
    process.exit(1);
  }
  return readFileSync(WORKLIST_FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, position) => {
      const columns = line.split("\t");
      if (columns.length < 2) {
        console.error(`worklist.tsv 형식이 잘못되었습니다: ${line.slice(0, 60)}`);
        process.exit(1);
      }
      const rowNumber = Number(columns[0]);
      if (rowNumber !== position) {
        console.error(
          `worklist.tsv ${position + 1}번째 줄의 행 번호가 ${rowNumber}입니다. 파일 순서가 손상되었습니다.`,
        );
        process.exit(1);
      }
      return { index: rowNumber, en: columns[columns.length - 1] };
    });
}

/** 원고 한 줄 → { worklist 번호(없으면 null), 번역 } */
function parseManuscriptLine(line: string): { rowNumber: number | null; ko: string } {
  const match = line.match(/^(\d+)\t(.*)$/);
  if (match) return { rowNumber: Number(match[1]), ko: match[2].trim() };
  return { rowNumber: null, ko: line };
}

/** "<파일>#<시작행>" 인자를 해석한다. */
function parseArg(arg: string, worklistSize: number): { path: string; offset: number } {
  const [path, offsetRaw] = arg.split("#");
  const offset = Number(offsetRaw ?? 0);
  if (!path || !Number.isInteger(offset) || offset < 0 || offset >= worklistSize) {
    console.error(
      `${arg}: 형식은 <파일>#<시작 행>이며 시작 행은 0..${worklistSize - 1} 범위여야 합니다.`,
    );
    process.exit(1);
  }
  return { path, offset };
}

const rows = readWorklist();
// 빌더와 같은 읽기 규칙: 손상된 캐시는 조용히 {}로 바꾸지 않고 멈춘다(R1-3).
const cache: Record<string, CacheEntry> = readJsonCache<Record<string, CacheEntry>>(
  CACHE_FILE,
  "번역 재사용 캐시(.corpus-cache/translations.json)",
  {},
);

let added = 0;
let overwritten = 0;
let skipped = 0;

for (const arg of process.argv.slice(2)) {
  const { path, offset } = parseArg(arg, rows.length);
  const manuscript = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseManuscriptLine);

  // 줄에 적힌 번호가 작업 목록 위치와 같은지 확인한다.
  manuscript.forEach((line, i) => {
    if (line.rowNumber === null) return; // 번호 없는 원고는 순서만 믿는다
    if (line.rowNumber !== offset + i) {
      console.error(
        `${path} ${i + 1}번째 줄: 예상 번호는 ${offset + i}인데 ${line.rowNumber}라고 적혀 있습니다. ` +
          `순서가 어긋났으므로 파일을 통째로 거부합니다.`,
      );
      process.exit(1);
    }
  });

  const remaining = rows.length - offset;
  if (manuscript.length > remaining) {
    console.error(
      `${path}: 번역 ${manuscript.length}줄이 남은 문장 수(${remaining})보다 많습니다. 순서가 어긋났을 수 있어 거부합니다.`,
    );
    process.exit(1);
  }

  manuscript.forEach(({ ko }, i) => {
    const row = rows[offset + i];
    if (!row) return;
    if (!hasHangul(ko)) {
      // 자체 정규식([가-힣])을 쓰면 자모·분해형 표기는 여기서만 "한글 없음"이 되어
      // 조용히 건너뛴다. check-translations는 통과하는 원고가 merge에서 버려진다(리뷰 2-11).
      console.warn(`  ! 건넙니다(한글 없음): ${row.en.slice(0, 40)}`);
      skipped++;
      return;
    }
    const foreign = foreignLetterRuns(ko);
    if (foreign.length > 0) {
      console.warn(`  ! 다른 언어 문자가 섞였습니다 [${foreign.join(" | ")}]: ${ko.slice(0, 50)}`);
    }
    const key = normalizeKey(row.en);
    if (cache[key]) overwritten++;
    else added++;
    cache[key] = { ko, hints: [] };
  });

  console.log(`  ${path} +${manuscript.length}줄 (작업 목록 ${offset + 1}~${offset + manuscript.length})`);
}

// 임시 파일로 썼다가 이름을 바꾼다. 쓰는 도중에 멈추면 캐시 전체(JSON 한 장)가 깨진다.
// 빌더는 부서진 캐시를 조용히 빈 캐시로 취급하므로, 1,400개 번역을 한 번에 잃을 수 있다.
mkdirSync(CACHE_DIR, { recursive: true });
writeJsonAtomically(CACHE_FILE, cache); // .corpus-cache/는 gitignore 대상
const stillMissing = rows.filter((row) => !cache[normalizeKey(row.en)]?.ko).length;
console.log(
  `캐시 합침: 신규 ${added} · 갱신 ${overwritten} · 건너뜀 ${skipped} — ` +
    `캐시 ${Object.keys(cache).length}항목 / 작업 목록 ${rows.length}문장 / 아직 번역 없음 ${stillMissing}문장`,
);

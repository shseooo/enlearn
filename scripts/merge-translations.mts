/**
 * 사람이(또는 모델이) 직접 번역한 원고를 번역 캐시에 합친다.
 *
 * 캐시(.corpus-cache/translations.json)의 키는 빌더와 같은 normalizeKey(en) 규약이다.
 * 따라서 캐시를 채워 두면 다음 빌드는 LLM 요청을 하나도 보내지 않고 이 번역을 그대로 쓴다.
 *   ENLEARN_LLM_HOST=... npm run corpus -- --lane=classic --offline --llm
 *
 * 원고 형식 (D3-2 — 두 칸짜리 옛 형식은 받지 않는다)
 *  - 한 줄에 한 문장, worklist와 같은 순서:
 *      <worklist 행 번호(0-based)><TAB><원문 앞부분><TAB><번역>
 *      505\tThe Rabbit thought about it for a whi\t토끼는 한동안 생각했다.
 *  - dump-untranslated.mts가 뽑는 .corpus-cache/manuscript.tsv가 같은 틀이다.
 *  - 번호가 한 줄이라도 어긋나면 파일 전체를 거부한다(순서가 밀리면 모든 번역이 엉뚱한 문장에 붙는다).
 *    번호가 없는 줄도 거부한다 — 빈 줄·탭 대신 쓴 공백은 순서를 밀지만 확인할 방법이 없다(리뷰 3-2).
 *  - 원문 앞부분은 worklist의 en과 대조한다. 두 줄을 맞바꾸거나 같은 번호를 이어 붙여
 *    순서를 다시 써도 번호만 맞으면 모든 번역이 엉뚱한 문장에 붙고 그대로 남는다(R6-4).
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

/**
 * 원고 한 줄 → { worklist 번호, 원문 앞부분, 번역 }.
 * 번호가 없거나 컬럼이 세 개가 아니면 null 표기로 처리해 호출자가 거부 사유를 말한다.
 */
type ManuscriptLine = {
  rowNumber: number | null;
  prefix: string;
  ko: string;
  columns: number;
};

function parseManuscriptLine(line: string): ManuscriptLine {
  const columns = line.split("\t");
  const hasNumber = /^\d+$/.test(columns[0]);
  return {
    rowNumber: hasNumber ? Number(columns[0]) : null,
    prefix: (columns[1] ?? "").trim(),
    ko: columns.slice(2).join("\t").trim(),
    columns: columns.length,
  };
}

/** 원문 앞부분 대조: 대소문자·연속 공백을 무시하고, worklist 원문의 접두어인지 본다. */
function normalizeForPrefix(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 원고에 적힌 "원문 앞부분"이 worklist의 en과 같은 문장을 가리키는지 본다.
 * 너무 짧은 조각("a" 같은)은 대조로 의미가 없다 — dump가 쓰는 접두어는 40자(R6-4).
 */
function prefixMatches(expected: string, prefix: string): boolean {
  const p = normalizeForPrefix(prefix);
  const e = normalizeForPrefix(expected);
  if (p.length < Math.min(8, e.length)) return false;
  return e.startsWith(p);
}

/** "<파일>#<시작행>" 인자를 해석한다. */
function parseArg(arg: string, worklistSize: number): { path: string; offset: number } {
  const [path, offsetRaw] = arg.split("#");
  const offset = Number(offsetRaw ?? 0);
  if (!path || !Number.isInteger(offset) || offset < 0 || offset >= worklistSize) {
    fail(
      `${arg}: 형식은 <파일>#<시작 행>이며 시작 행은 0..${worklistSize - 1} 범위여야 합니다.`,
    );
  }
  return { path, offset };
}

/**
 * 실패를 안내로 끝낸다(R4-2/R6-9).
 *
 * ⚠️ 실제 쓰기는 모든 원고를 검증한 뒤 마지막에 한 번 일어난다. 앞 파일의 합침 로그를
 * 먼저 남긴 채 뒤 파일이 실패하면 캐시는 통째로 그대로인데 사용자는 합쳐진 줄 안다(R7-5).
 * 그래서 모든 실패 경로가 "저장되지 않았다"를 함께 말한다.
 */
function fail(message: string): never {
  console.error(message);
  console.error("원고를 합치지 못했습니다 — 어떤 원고도 캐시에 저장되지 않았습니다.");
  process.exit(1);
}

/** 합친 개수. 전역이 아니라 main()이 들고 있는 지역 값이다(R7-5). */
type Counters = { added: number; overwritten: number; skipped: number };

/** 원고 파일을 읽는다. 경로 오타에서 스택 트레이스를 보여주지 않는다(R4-2). */
function readManuscript(path: string): ManuscriptLine[] {
  // check-translations.mts와 같은 문장: 사람은 "어떤 파일이 없는지" 먼저 알아야 한다.
  if (!existsSync(path)) {
    fail(
      `파일을 찾을 수 없습니다: ${path} — 원고 경로와 "#<시작 행>"을 확인하세요. ` +
        `원고는 보통 .corpus-cache/ko/ 아래에 있습니다.`,
    );
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseManuscriptLine);
}

/**
 * 원고 한 파일을 검증해 캐시 객체에 합친다(실제 쓰기는 main이 마지막에 한 번 한다).
 * 번호 어긋남·원문 앞부분 불일치는 그 자리에서 거부한다.
 * (예상 밖 오류를 한 줄 안내로 끝내려고 함수로 묶었다 — 리뷰 4-2)
 */
function mergeOne(
  arg: string,
  rows: WorklistRow[],
  cache: Record<string, CacheEntry>,
  counters: Counters,
): void {
  const { path, offset } = parseArg(arg, rows.length);
  const manuscript = readManuscript(path)

  // 줄에 적힌 번호가 작업 목록 위치와 같은지, 원문 앞부분이 같은 문장을 가리키는지 확인한다.
  manuscript.forEach((line, i) => {
    if (line.rowNumber === null) {
      // 빈 줄을 지웠으니 "번호 없는 줄만 믿는다"로는 원고 중간 빈 줄 한 줄이
      // 모든 번역을 한 칸 어긋나게 만드는 것을 잡지 못한다. 탭 대신 공백을 쓴
      // 줄도 같은 경로로 어긋난다. 헤더가 약속한 형식이므로 거부한다(리뷰 3-2).
      fail(
        `${path} ${i + 1}번째 줄에 worklist 행 번호(<번호>\t)가 없습니다. ` +
          `순서가 밀리면 모든 번역이 엉뚱한 문장에 붙으므로 파일을 통째로 거부합니다.`,
      );
    }
    if (line.rowNumber !== offset + i) {
      fail(
        `${path} ${i + 1}번째 줄: 예상 번호는 ${offset + i}인데 ${line.rowNumber}라고 적혀 있습니다. ` +
          `순서가 어긋났으므로 파일을 통째로 거부합니다.`,
      );
    }
    if (line.columns < 3) {
      // 옛 형식(<번호>\t<번역>)은 여기서 받지 않는다(D3-2: 호환 없음).
      fail(
        `${path} ${i + 1}번째 줄에 컬럼이 ${line.columns}개입니다. 원고 형식은 ` +
          `<번호>\t<원문 앞부분>\t<번역> 세 칸입니다(dump-untranslated.mts가 뽑는 manuscript.tsv를 쓰세요).`,
      );
    }
    const row = rows[offset + i];
    if (row && !prefixMatches(row.en, line.prefix)) {
      fail(
        `${path} ${i + 1}번째 줄: 원문 앞부분이 worklist와 다릅니다. ` +
          `원고에는 "${line.prefix.slice(0, 40)}", worklist에는 "${row.en.slice(0, 40)}" — ` +
          `두 줄이 맞바뀌었거나 순서가 다시 쓰였을 수 있어 파일을 통째로 거부합니다.`,
      );
    }
  });

  const remaining = rows.length - offset;
  if (manuscript.length > remaining) {
    fail(
      `${path}: 번역 ${manuscript.length}줄이 남은 문장 수(${remaining})보다 많습니다. 순서가 어긋났을 수 있어 거부합니다.`,
    );
  }

  manuscript.forEach(({ ko }, i) => {
    const row = rows[offset + i];
    if (!row) return;
    if (!hasHangul(ko)) {
      // 자체 정규식([가-힣])을 쓰면 자모·분해형 표기는 여기서만 "한글 없음"이 되어
      // 조용히 건너뛴다. check-translations는 통과하는 원고가 merge에서 버려진다(리뷰 2-11).
      console.warn(`  ! 건넙니다(한글 없음): ${row.en.slice(0, 40)}`);
      counters.skipped++;
      return;
    }
    const foreign = foreignLetterRuns(ko);
    if (foreign.length > 0) {
      console.warn(`  ! 다른 언어 문자가 섞였습니다 [${foreign.join(" | ")}]: ${ko.slice(0, 50)}`);
    }
    const key = normalizeKey(row.en);
    if (cache[key]) counters.overwritten++;
    else counters.added++;
    cache[key] = { ko, hints: [] };
  });

  // ⚠️ 아직 저장하지 않았다. 뒤 파일이 실패하면 이 합침도 함께 무효가 된다(R7-5).
  console.log(
    `  ${path} ${manuscript.length}줄 검증됨 (작업 목록 ${offset + 1}~${offset + manuscript.length}) — 아직 저장 안 함`,
  );
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error(
      "사용: node scripts/merge-translations.mts <원고 파일>#<시작 행> [<원고 파일>#<시작 행> …] " +
        "(원고 틀은 node scripts/dump-untranslated.mts로 뽑습니다)",
    );
    process.exit(2);
  }
  const rows = readWorklist();
  // 빌더와 같은 읽기 규칙: 손상된 캐시는 조용히 {}로 바꾸지 않고 멈춘다(R1-3).
  const cache: Record<string, CacheEntry> = readJsonCache<Record<string, CacheEntry>>(
    CACHE_FILE,
    "번역 재사용 캐시(.corpus-cache/translations.json)",
    {},
  );

  const counters: Counters = { added: 0, overwritten: 0, skipped: 0 };
  for (const arg of files) mergeOne(arg, rows, cache, counters);

  // 임시 파일로 썼다가 이름을 바꾼다. 쓰는 도중에 멈추면 캐시 전체(JSON 한 장)가 깨진다.
  // 빌더는 부서진 캐시를 조용히 빈 캐시로 취급하므로, 1,400개 번역을 한 번에 잃을 수 있다.
  mkdirSync(CACHE_DIR, { recursive: true });
  writeJsonAtomically(CACHE_FILE, cache); // .corpus-cache/는 gitignore 대상
  const stillMissing = rows.filter((row) => !cache[normalizeKey(row.en)]?.ko).length;
  console.log(
    `캐시 합침: 신규 ${counters.added} · 갱신 ${counters.overwritten} · 건너뜀 ${counters.skipped} — ` +
      `캐시 ${Object.keys(cache).length}항목 / 작업 목록 ${rows.length}문장 / 아직 번역 없음 ${stillMissing}문장`,
  );
}

try {
  main();
} catch (e) {
  // 예상 밖 오류도 한 줄 안내로 끝낸다(R4-2). 캐시 읽기·마지막 쓰기까지 같은 try 안에 있어,
  // 실패 원인이 스택 트레이스가 아니라 한국어 안내로 남는다(R6-9).
  // ⚠️ 앞에 "검증됨" 로그가 있어도 캐시는 그대로다 — 그 사실을 분명히 남긴다(R7-5).
  console.error(`원고를 합치지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  console.error("어떤 원고도 캐시에 저장되지 않았습니다.");
  process.exit(1);
}


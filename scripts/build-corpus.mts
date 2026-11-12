/**
 * 코퍼스 빌드 스크립트.
 *
 *   npm run corpus                 # 두 레인 모두
 *   npm run corpus -- --lane=daily # 일상 회화만
 *   npm run corpus -- --offline    # 이미 받아둔 원문으로 다시 정제만
 *   npm run corpus -- --llm        # 동화 문장에 한국어 번역/힌트를 미리 입혀둠
 *   npm run corpus -- --force      # 수록이 급감해도 기존 코퍼스 파일을 덮어씀(리뷰 3-1)
 *
 * 원본 내려받기는 .corpus-cache/ 에 저장하므로 재실행 시 네트워크를 쓰지 않는다.
 * 결과물은 public/data/corpus/{daily,classics}.json
 */
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CorpusEntry,
  CorpusFile,
  CorpusLane,
  CorpusSourceInfo,
} from "../src/lib/types.ts";
import {
  buildFrequency,
  computeGradeCutoffs,
  gradeDifficulty,
  isPracticeSentence,
  normalizeKey,
  normalizeProse,
  pickHints,
  splitSentences,
  stripGutenbergBoilerplate,
  stripWikisourceMarkup,
  hasGutenbergEndMarker,
} from "../src/lib/corpus-tools.ts";
import { parseTranslationBatch } from "../src/lib/parse-batch.ts";
import { checkHost } from "../src/lib/host.ts";
import { isRetryableStatus } from "../src/lib/http-status.ts";
import { hasHangul } from "./lib/foreign-text.ts";
import { readJsonCache, writeAtomic, writeJsonAtomically } from "./lib/json-file.ts";

// ---------------------------------------------------------------------------
// 목록
// ---------------------------------------------------------------------------

interface Book {
  id: string;
  title: string;
  author: string;
  /** Project Gutenberg ebook id */
  gutenberg?: number;
}

/**
 * 퍼블릭 도메인 어린이 문학 (미국 기준 저작권 만료).
 * ⚠️ 『어린왕자(The Little Prince)』는 1943년 미국 출판이라 저작권이 남아 있어
 *    파일을 배포할 수 없다. 같은 결의 『벨벳 토끼』『버드나무를 타고』로 대체했다.
 */
const BOOKS: Book[] = [
  { id: "alice", title: "이상한 나라의 앨리스", author: "Lewis Carroll", gutenberg: 11 },
  { id: "looking-glass", title: "거울을 통한 이상한 나라의 앨리스", author: "Lewis Carroll", gutenberg: 12 },
  { id: "peter-pan", title: "피터팬 (Peter and Wendy)", author: "J. M. Barrie", gutenberg: 16 },
  { id: "wizard-of-oz", title: "오즈의 마법사", author: "L. Frank Baum", gutenberg: 55 },
  { id: "secret-garden", title: "비밀의 화원", author: "Frances Hodgson Burnett", gutenberg: 113 },
  { id: "wind-in-the-willows", title: "버드나무를 타고 (The Wind in the Willows)", author: "Kenneth Grahame", gutenberg: 289 },
  { id: "pinocchio", title: "피노키오", author: "Carlo Collodi", gutenberg: 500 },
  { id: "velveteen-rabbit", title: "벨벳 토끼 (The Velveteen Rabbit)", author: "Margery Williams", gutenberg: 11757 },
  { id: "aesop-children", title: "이솝우화 (The Aesop for Children)", author: "Aesop", gutenberg: 19994 },
  { id: "aesop-300", title: "이솝우화 300편", author: "Aesop", gutenberg: 21 },
  { id: "andersen", title: "안데르센 동화집", author: "H. C. Andersen", gutenberg: 1597 },
  { id: "grimm", title: "그림 형제 동화집", author: "Jacob & Wilhelm Grimm", gutenberg: 2591 },
  { id: "korean-fairy", title: "한국 요정 이야기 (Korean Fairy Tales)", author: "W. E. Griffis", gutenberg: 67180 },
  { id: "korean-folk", title: "한국 옛날 이야기 (Imps, Ghosts and Fairies)", author: "Pang Im & Yuk Yi", gutenberg: 51002 },
];

const DAILY_URL = "https://www.manythings.org/anki/kor-eng.zip";
const UA = "EnLearn-corpus-builder/0.1 (personal English study app)";

// ---------------------------------------------------------------------------
// 인자 / 경로
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/**
 * 이 파일을 직접 실행한 것인지 (테스트에서는 순수 함수·실행 함수만 import한다).
 * 아래에서 한 번 더 계산하지만, 인자 검증이 모듈 평가 시점에 돌아가므로 여기서도 본다.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

/**
 * 인자 오류는 한국어 안내 한 줄로 끝난다(R6-9). 이 검증은 모듈 평가 시점에 돌아
 * `main().catch`를 거치지 않는다 — 그대로 두면 사용자는 안내 뒤에 스택 트레이스를 본다.
 * 테스트 import(imported)에서는 던진다: 프로세스를 죽이는 것은 CLI만 한다.
 */
function failUsage(message: string): never {
  if (!invokedDirectly) throw new Error(message);
  console.error(`빌드 실패: ${message}`);
  console.error(
    "사용: npm run corpus -- [--lane=daily|classic|all] [--per-book=N] [--daily-cap=N] " +
      "[--classic-cap=N] [--batch=N] [--concurrency=N] [--offline] [--llm] [--force]",
  );
  process.exit(1);
}

const LANES: CorpusLane[] = (() => {
  const lane = flag("lane", "all");
  if (lane === "all") return ["daily", "classic"];
  if (lane === "daily" || lane === "classic") return [lane];
  failUsage(`--lane 은 daily | classic | all 중 하나여야 합니다. (받은 값: ${lane})`);
})();
const OFFLINE = argv.includes("--offline");
const WITH_LLM = argv.includes("--llm");
/** 기존 코퍼스 대비 수록이 급감해도 덮어쓰겠다고 명시한 실행 (리뷰 3-1) */
const FORCE = argv.includes("--force");

/** 숫자 아닌 값을 Number()로 바꾸면 NaN이 되어 밸런싱이 조용히 깨진다. */
const positiveInt = (name: string, fallback: number): number => {
  const raw = flag(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    failUsage(`--${name} 은 0보다 큰 정수여야 합니다. (받은 값: ${raw})`);
  }
  return n;
};

const PER_BOOK = positiveInt("per-book", 180);
const DAILY_CAP = positiveInt("daily-cap", 3000);
const CLASSIC_CAP = positiveInt("classic-cap", 1400);
/** --llm 사용 시 요청 단위 / 동시 요청 수 (사이트·프로바이더 배려로 낮게) */
const LLM_BATCH = Math.min(positiveInt("batch", 10), 30);
const LLM_CONCURRENCY = Math.min(positiveInt("concurrency", 3), 8);
/** 테스트·기록용: 실제 배치 크기(--batch로 바뀐다) */
export const LLM_BATCH_SIZE = LLM_BATCH;
/**
 * 작업 루트. 기본은 현재 위치지만 테스트는 임시 작업 공간을 가리킨다
 * (실제 .corpus-cache/translations.json를 망가뜨리지 않게, 리뷰 1-9).
 */
const ROOT = process.env.ENLEARN_CORPUS_ROOT ?? process.cwd();
const CACHE_DIR = join(ROOT, ".corpus-cache");
const OUT_DIR = join(ROOT, "public", "data", "corpus");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 내려받기 (재시도 + 캐시)
// ---------------------------------------------------------------------------

function decodeBytes(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    // Gutenberg 구버전 파일은 Windows-1252
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export async function fetchBytes(url: string, attempts = 3): Promise<Buffer> {
  let lastError = "알 수 없는 오류";
  for (let i = 0; i < attempts; i++) {
    let retryable = true;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = `HTTP ${res.status}`;
      // 오류 본문도 소비한다. 본문을 읽지 않으면 undici가 그 연결을 "사용 중"으로
      // 붙들고, 429/5xx가 이어지는 네트워크에서 시도마다 연결이 남는다(R4-6).
      await res.body?.cancel().catch(() => {});
      // 404/403은 다시 시도해도 똑같이 실패한다 — LLM 쪽과 같은 판정을 쓴다(리뷰 3-11)
      retryable = isRetryableStatus(res.status);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (!retryable) break;
    if (i + 1 >= attempts) break; // 마지막 실패 뒤에는 헛되이 기다리지 않는다
    const wait = 1500 * (i + 1);
    console.log(`  ↻ 실패(${lastError}) ${wait}ms 후 재시도`);
    await sleep(wait);
  }
  throw new Error(`${url} 내려받기 실패: ${lastError}`);
}

/**
 * 캐시된 원본이 "완성본"인지 확인한다(R4-1).
 * `cachedBytes`는 예전에는 existsSync만 봤다. 쓰는 도중에 죽어 앞부분만 남은 파일을
 * 완성본으로 쓰면, 꼬리 마커를 잃은책이 다음 빌드부터 앞부분만으로 조용히 참여한다.
 */
export function isCompleteGutenbergText(buf: Buffer): boolean {
  return hasGutenbergEndMarker(decodeBytes(buf));
}

/** 원본은 캐시에 저장해 두므로 재실행 시 네트워크를 쓰지 않는다.
 * (테스트는 fetch를 주입해 이 경로를 확인한다 — R6-8) */
export async function cachedBytes(
  name: string,
  urls: string[],
  complete?: (buf: Buffer) => boolean,
): Promise<Buffer> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, name);
  if (existsSync(path)) {
    const cached = readFileSync(path);
    if (!complete || complete(cached)) return cached;
    // 잘린 캐시를 버리고 다시 내려받는다 — "있으면 완성본"으로 취급하면 안 된다(R4-1).
    console.log(`  ! 캐시된 ${name}이(가) 완성본이 아닙니다(끝 마커 없음) — 다시 내려받습니다`);
    if (OFFLINE) {
      throw new Error(
        `캐시가 불완전합니다(--offline): ${name} — 끝 마커가 없다. 네트워크가 있을 때 다시 내려받으세요.`,
      );
    }
  }
  if (OFFLINE) throw new Error(`캐시에 없음(--offline): ${name}`);

  let error: Error | null = null;
  for (const url of urls) {
    try {
      const buf = await fetchBytes(url);
      // 막 내려받은 바이트도 같은 검사로 본다(R5-1/R6-8). 여기만 걸러야 잘린 원본이
      // 캐시에도 들어가지 않고, 이번 빌드의 buildClassic()에도 흐르지 않는다.
      // 원본 서버가 잘린 파일을 준 경우가 이 경로로 들어온다.
      if (complete && !complete(buf)) {
        throw new Error(
          `${name}의 원본이 완성본이 아닙니다(끝 마커 없음) — ` +
            `잘린 원본은 캐시에 쓰지 않습니다. 다른 주소도 같은지 확인하세요.`,
        );
      }
      // 제자리 덮어쓰기는 잘린 파일을 남긴다. 그 파일이 "완성된 원본"으로 재사용된다(R4-1).
      writeAtomic(path, buf);
      await sleep(1200); // 사이트 배려: 요청 사이에 쉬는 시간
      return buf;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      console.log(`  ✗ ${url} — ${error.message}`);
    }
  }
  throw error ?? new Error(name);
}

/** 펼쳐진 크기 상한. 손상·교란된 zip 하나가 프로세스를 다 먹지 않게 한다(리뷰 3-10). */
export const MAX_UNZIP_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * 외부 프로그램 없이 zip을 푼다 (stored/deflate만 지원).
 * ⚠️ 네트워크에서 받은 바이트를 파싱하므로 모든 읽기에 경계 검사를 한다.
 * 검사가 없으면 잘린 파일에서 원인 없는 RangeError가 난다(리뷰 1-17).
 */
export function unzipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 구조를 읽을 수 없습니다(EOCD 없음).");

  const outOfBounds = (off: number, size: number): boolean =>
    !Number.isInteger(off) || off < 0 || off + size > buf.length;
  const read16 = (off: number, what: string): number => {
    if (outOfBounds(off, 2)) {
      throw new Error(
        `zip 구조가 손상되었습니다: ${what} 위치(${off})가 파일 길이(${buf.length}바이트)를 벗어났습니다.`,
      );
    }
    return buf.readUInt16LE(off);
  };
  const read32 = (off: number, what: string): number => {
    if (outOfBounds(off, 4)) {
      throw new Error(
        `zip 구조가 손상되었습니다: ${what} 위치(${off})가 파일 길이(${buf.length}바이트)를 벗어났습니다.`,
      );
    }
    return buf.readUInt32LE(off);
  };

  const count = read16(eocd + 10, "중앙 디렉터리 항목 수");
  let off = read32(eocd + 16, "중앙 디렉터리 시작 위치");
  const out: { name: string; data: Buffer }[] = [];

  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      console.log(`  ! zip 중앙 디렉터리가 ${i + 1}번째 항목에서 끊겼습니다 (나머지는 건너뜀)`);
      break;
    }
    const method = read16(off + 10, "압축 방식");
    const compSize = read32(off + 20, "압축 크기");
    const nameLen = read16(off + 28, "파일 이름 길이");
    const extraLen = read16(off + 30, "추가 필드 길이");
    const commentLen = read16(off + 32, "주석 길이");
    const localOff = read32(off + 42, "로컬 헤더 위치");
    if (off + 46 + nameLen > buf.length) {
      throw new Error(
        `zip 구조가 손상되었습니다: 파일 이름 영역이 파일 길이를 벗어났습니다(${off + 46 + nameLen} > ${buf.length}).`,
      );
    }
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (localOff + 4 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      throw new Error(
        `zip 구조가 손상되었습니다: ${name}의 로컬 파일 헤더 위치(${localOff})가 잘못되었습니다.`,
      );
    }
    const localNameLen = read16(localOff + 26, "로컬 파일 이름 길이");
    const localExtraLen = read16(localOff + 28, "로컬 추가 필드 길이");
    const start = localOff + 30 + localNameLen + localExtraLen;
    if (start < 0 || start + compSize > buf.length) {
      throw new Error(
        `zip 구조가 손상되었습니다: ${name}의 데이터 영역(${start}+${compSize})이 파일 길이를 벗어났습니다.`,
      );
    }
    const raw = buf.subarray(start, start + compSize);
    try {
      out.push({
        name,
        data:
          method === 8
            ? inflateRawSync(raw, { maxOutputLength: MAX_UNZIP_ENTRY_BYTES })
            : raw,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string })?.code;
      // 압축은 작고 출력은 큰 항목(zip bomb)은 OOM 크래시 대신 안내로 끝난다
      if (code === "ERR_BUFFER_TOO_LARGE" || /maxOutputLength/i.test(reason)) {
        throw new Error(
          `zip 안의 ${name}이(가) 비정상적으로 큽니다(펼친 크기 상한 ${MAX_UNZIP_ENTRY_BYTES}바이트 초과).`,
        );
      }
      throw new Error(`zip 안의 ${name}을(를) 펼치지 못했습니다(파일이 손상되었습니다): ${reason}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 일상 회화 레인 (Tatoeba 한↔영어)
// ---------------------------------------------------------------------------

/**
 * 한글 문장 판정. 범위는 scripts/lib/foreign-text.ts의 공통 규칙을 쓴다.
 * ⚠️ 예전 범위([\u3131-\uD79D])는 CJK 한자·Bamum까지 담아 한글이 한 자도 없는
 * 일본어/중국어 문장이 통과했다(리뷰 1-5 / 1-11).
 */
export function acceptsDailyKorean(ko: string): boolean {
  return hasHangul(ko) && ko.length >= 4 && ko.length <= 80 && /[.!?…]$/.test(ko);
}

/** Tatoeba attribution 문자열에서 문장 id만 뽑는다 (출처 표기용) */
function tatoebaIds(attribution: string): string {
  const ids = [...attribution.matchAll(/#(\d+)/g)].map((m) => m[1]);
  return ids.join("/");
}

const DAILY_BAD = /[()[\]{}<>|#*_~\\/]|https?:|www\./;

function buildDaily(): { entries: CorpusEntry[]; attribution: string } {
  const buf = bytesQueue.daily;
  const zip = unzipEntries(buf);
  const textFile =
    zip.find((f) => f.name.endsWith(".txt") && !f.name.startsWith("_")) ?? zip[0];
  if (!textFile) throw new Error("kor-eng.zip 안에서 텍스트 파일을 찾지 못했습니다.");

  const lines = decodeBytes(textFile.data).split(/\r?\n/);
  const seen = new Set<string>();
  const entries: CorpusEntry[] = [];
  let attributionNote = "CC-BY 2.0 (France)";

  for (const line of lines) {
    const [en, ko, attribution = ""] = line.split("\t");
    if (!en || !ko) continue;
    if (attribution.includes("CC-BY")) attributionNote = attribution.split("Attribution")[0].trim();

    const enText = en.trim();
    const koText = ko.trim();
    if (!isPracticeSentence(enText, { minWords: 4, maxWords: 16 })) continue;
    if (DAILY_BAD.test(enText) || DAILY_BAD.test(koText)) continue;
    if (!acceptsDailyKorean(koText)) continue;

    const key = normalizeKey(enText);
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push({
      lane: "daily",
      en: enText,
      ko: koText,
      hints: [], // 빈도는 아래에서 채운다
      difficulty: "normal",
      source: "Tatoeba",
      sourceId: tatoebaIds(attribution) || undefined,
    });
  }

  return { entries, attribution: attributionNote };
}

// ---------------------------------------------------------------------------
// 동화 레인 (Project Gutenberg)
// ---------------------------------------------------------------------------

function loadBookText(book: Book): string {
  const id = book.gutenberg;
  if (!id) throw new Error(`${book.id}: 출처 없음`);
  const buf = bytesQueue.books.get(book.id);
  if (!buf) throw new Error(`${book.id}: 원문 없음`);
  let text = decodeBytes(buf);
  text = stripGutenbergBoilerplate(text);
  if (/<[a-z][a-z0-9]*\s/i.test(text.slice(0, 400))) {
    // 일부 파일은 XHTML이라 마크업을 걷어낸다
    text = stripWikisourceMarkup(text);
  }
  return normalizeProse(text);
}

function buildClassic(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const seen = new Set<string>();

  for (const book of BOOKS) {
    let body: string;
    try {
      body = loadBookText(book);
    } catch (e) {
      console.log(`  ! ${book.title}: 건너뜀 (${e instanceof Error ? e.message : e})`);
      continue;
    }
    const candidates = splitSentences(body).filter((s) =>
      isPracticeSentence(s, { minWords: 7, maxWords: 18 }),
    );
    let taken = 0;
    for (const s of candidates) {
      if (taken >= PER_BOOK) break;
      const key = normalizeKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        lane: "classic",
        en: s,
        ko: null, // 앱에서 LLM 번역(1회) 후 캐시
        hints: [],
        difficulty: "normal",
        source: book.title,
        sourceId: book.id,
      });
      taken++;
    }
    console.log(`  ✓ ${book.title}: 후보 ${candidates.length} → 수록 ${taken}`);
  }
  return entries;
}

/** 난이도 균형이 맞춰진 문장들로 책 목록(개수)을 다시 세는다 */
function sourcesFromClassic(entries: CorpusEntry[]): CorpusSourceInfo[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const id = e.sourceId ?? e.source;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return BOOKS.filter((b) => counts.has(b.id)).map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    count: counts.get(b.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// LLM로 한국어 사전 부여 (선택)
// ---------------------------------------------------------------------------

interface LlmEnv {
  host: string;
  model: string;
  apiKey: string;
}

function llmFromEnv(): LlmEnv | null {
  const host = process.env.ENLEARN_LLM_HOST ?? "";
  const model = process.env.ENLEARN_LLM_MODEL ?? "";
  // 키가 없는 로컬 호스트(Ollama 등)도 있으므로 apiKey는 비어 둘 수 있다
  const apiKey = process.env.ENLEARN_LLM_API_KEY ?? "";
  return host && model ? { host, model, apiKey } : null;
}

/**
 * 번역 재사용 캐시 (.corpus-cache/translations.json)
 * 1,400문장을 한 번에 옮기는 작업은 중단될 수 있다. 죽은 자리에서 다시 시작해도
 * 이미 번역한 문장은 다시 요청하지 않는다.
 */
type TranslationCache = Record<string, { ko: string; hints: string[] }>;
const TRANSLATION_CACHE_FILE = join(CACHE_DIR, "translations.json");

export function loadTranslationCache(): TranslationCache {
  // 파싱 실패를 {}로 삼키면 이미 끝낸 1,400개 번역을 "0건"으로 잃는다(리뷰 1-3).
  return readJsonCache<TranslationCache>(
    TRANSLATION_CACHE_FILE,
    "번역 재사용 캐시(.corpus-cache/translations.json)",
    {},
  );
}

export function saveTranslationCache(cache: TranslationCache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  // 임시 파일 + rename. 제자리에서 덮어쓰다 멈추면 캐시 한 장이 통째로 깨진다.
  // merge-translations.mts가 쓰던 방법과 같은 헬퍼를 쓴다(R3-1/R1-3).
  writeJsonAtomically(TRANSLATION_CACHE_FILE, cache);
}

const BATCH_SYSTEM_PROMPT = `너는 영어 문장을 학습용 한국어로 옮기는 번역기다.
- 중학생 교과서가 쓰는 자연스러운 현대 한국어로, 문장 순서와 뜻을 지켜 옮긴다.
- 각 문장에는 연습 힌트로 그 문장에 나온 영어 단어 2~4개(소문자 기본형)를 곁들인다.
- 답은 {"items":[{"i":번호,"ko":"한국어 문장","hints":["word"]}]} JSON 하나만. 설명 금지.`;

export const LLM_TIMEOUT_MS = 120_000;
export const LLM_RETRIES = 3;

/**
 * OpenAI 호환 /chat/completions 호출. 브라우저 쪽(src/lib/llm.ts)과 동작을
 * 맞춘다(타임아웃, 재시도 상태, Retry-After 존중, 키 없는 호스트 지원).
 * 재시도할 상태 집합은 이제 공용 모듈에서 가져온다 — 예전에는 node가 확장자 없는
 * import를 해석하지 못해 복제돼 있었고, 실제로 409 한 항목이 어긋나 있었다(리뷰 2-12).
 */
export type ChatAttempt = {
  ok: boolean;
  content?: string;
  retryable: boolean;
  message: string;
  /** Retry-After 헤더가 알려준 대기 시간(ms, 없으면 undefined) */
  retryAfterMs?: number;
};

/**
 * 한 번의 요청. 예외를 던지지 않고 결과를 돌려준다.
 * 이전에 비재시도 응답(400/401)을 try 안에서 던져 자기 catch가 잡아
 * 무작정 재시도했다 — 재시도 여부와 대기 시간을 여기서 결정한다(리뷰 3-7).
 */
export async function requestChatOnce(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<ChatAttempt> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      const retryable = isRetryableStatus(res.status);
      // 오류 본문도 소비한다(브라우저 쪽 src/lib/llm.ts와 같은 규칙, R4-6).
      // 본문을 읽지 않고 버리면 undici가 그 연결을 "사용 중"으로 붙들고,
      // 배치 140회를 도는 빌드에서 429/5xx마다 연결이 남는다.
      await res.body?.cancel().catch(() => {});
      const hint =
        res.status === 401 || res.status === 403
          ? " — API 키를 확인하세요"
          : res.status === 404
            ? " — host/model 경로를 확인하세요"
            : "";
      const wait = Number(res.headers.get("retry-after"));
      return {
        ok: false,
        retryable,
        message: `HTTP ${res.status} ${res.statusText}${hint}`,
        retryAfterMs: Number.isFinite(wait) && wait > 0 ? Math.min(wait * 1000, 15_000) : undefined,
      };
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content.trim()) {
      return { ok: false, retryable: true, message: "빈 응답" };
    }
    return { ok: true, content, retryable: false, message: "" };
  } catch (err) {
    // 연결 실패·타임아웃은 다시 시도할 가치가 있다
    return {
      ok: false,
      retryable: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * host → /chat/completions 정규화는 설정 화면과 같은 checkHost를 쓴다(리뷰 3-12).
 * 두 곳에 복제된 규칙 중 한 쪽만 어긋나면 빌드는 실패하고 안내는 어긋난 쪽에서 나온다.
 */
export function chatEndpoint(host: string): string {
  const check = checkHost(host);
  if (!check.ok) {
    throw new Error(`ENLEARN_LLM_HOST가 올바르지 않습니다: ${check.message}`);
  }
  return check.endpoint;
}

async function requestChat(
  env: LlmEnv,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<string> {
  const url = chatEndpoint(env.host);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.apiKey) headers.Authorization = `Bearer ${env.apiKey}`;
  const body = {
    model: env.model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages,
  };

  let lastError = "";
  for (let attempt = 0; attempt <= LLM_RETRIES; attempt++) {
    const result = await requestChatOnce(url, headers, body);
    if (result.ok) return result.content!;
    lastError = result.message;
    if (!result.retryable) break; // 잘못된 요청은 재시도해도 똑같이 실패한다
    if (attempt === LLM_RETRIES) break;
    await sleep(result.retryAfterMs ?? 800 * 2 ** attempt);
  }
  throw new Error(lastError || "LLM 호출 실패");
}

/**
 * 번역 재사용 캐시를 언제 디스크에 쓰는지 판정 (리뷰 2-10).
 * 배치마다 1,400항목을 직렬화하면 재개 안전망 대비 쓰기가 반복된다(워커 최대 8개).
 * 묶어서 써도 "죽은 자리에서 다시 시작"은 유지된다.
 */
export const TRANSLATION_CACHE_FLUSH_BATCHES = 10;
export const TRANSLATION_CACHE_FLUSH_MS = 5_000;

export function shouldFlushTranslationCache(
  batchesSinceFlush: number,
  msSinceFlush: number,
): boolean {
  return (
    batchesSinceFlush >= TRANSLATION_CACHE_FLUSH_BATCHES ||
    msSinceFlush >= TRANSLATION_CACHE_FLUSH_MS
  );
}

/** 한 번에 여러 문장을 번역한다. (문장당 1호출이면 1,400호출이라 너무 느리다) */
async function translateBatch(
  env: LlmEnv,
  sentences: string[],
): Promise<Map<string, { ko: string; hints: string[] }>> {
  const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const content = await requestChat(
    env,
    [
      { role: "system", content: BATCH_SYSTEM_PROMPT },
      { role: "user", content: numbered },
    ],
    90 * sentences.length + 300,
  );
  // 폐기한 이유를 남긴다. 조용히 넘어가면 "번역이 왜 없지?"를 추적할 수 없다(리뷰 2-1).
  return parseTranslationBatch(content, sentences, (reason) => {
    console.log(`  ! 응답 번호 대응 폐기: ${reason}`);
  });
}

/** 코퍼스 항목에 한국어가 없으면 LLM으로 채운다 (캐시 재사용 + 유한 동시성) */
export async function fillKoreanTranslations(
  entries: CorpusEntry[],
  env: LlmEnv,
): Promise<void> {
  const cache = loadTranslationCache();
  let reused = 0;
  for (const e of entries) {
    if (e.ko) continue;
    const hit = cache[normalizeKey(e.en)];
    if (hit?.ko) {
      e.ko = hit.ko;
      if (hit.hints?.length) e.hints = hit.hints;
      reused += 1;
    }
  }
  if (reused) console.log(`  이미 번역한 문장 ${reused}개 재사용`);

  const todo = entries.filter((e) => !e.ko);
  if (!todo.length) {
    console.log("  번역이 필요한 문장이 없습니다.");
    return;
  }

  const batches: CorpusEntry[][] = [];
  for (let i = 0; i < todo.length; i += LLM_BATCH) {
    batches.push(todo.slice(i, i + LLM_BATCH));
  }
  console.log(
    `· 동화 ${todo.length}문장 → 배치 ${batches.length}개 (${LLM_BATCH}문장/요청, 동시 ${LLM_CONCURRENCY})`,
  );

  let done = 0;
  let failed = 0;
  let cursor = 0;
  let batchesDone = 0;
  let batchesSinceFlush = 0;
  let lastFlushAt = Date.now();
  const flush = (): void => {
    saveTranslationCache(cache);
    batchesSinceFlush = 0;
    lastFlushAt = Date.now();
  };
  const worker = async (): Promise<void> => {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      try {
        const map = await translateBatch(env, batch.map((e) => e.en));
        for (const e of batch) {
          const hit = map.get(e.en);
          if (!hit) continue;
          e.ko = hit.ko;
          if (hit.hints.length) e.hints = hit.hints;
          cache[normalizeKey(e.en)] = { ko: hit.ko, hints: hit.hints };
          done += 1;
        }
        failed += batch.length - map.size;
      } catch (err) {
        failed += batch.length;
        console.log(
          `\n  ! 배치 실패(건너뜀): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      batchesDone += 1;
      // 배치마다 1,400항목짜리 캐시를 통째로 직렬화하지 않는다(리뷰 2-10).
      // 재개 안전망은 묶기 단위 아래에서도 유지된다.
      batchesSinceFlush += 1;
      if (shouldFlushTranslationCache(batchesSinceFlush, Date.now() - lastFlushAt)) {
        flush();
      }
      // 요청 수(140+)가 로그를 뒤덮지 않게 20배치마다 한 줄만 남긴다
      if (batchesDone % 20 === 0 || cursor >= batches.length) {
        process.stdout.write(
          `  번역 ${done}/${todo.length} (실패 ${failed}, 배치 ${batchesDone}/${batches.length})\n`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, worker),
  ).finally(flush); // 실패로 끝나도 이미 번역한 문장은 잃지 않는다
  process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

/** 병렬 다운로드를 피하기 위해 순차로 미리 모아둔다 (사이트 배려) */
const bytesQueue: { daily: Buffer; books: Map<string, Buffer> } = {
  daily: Buffer.alloc(0),
  books: new Map(),
};

const pgUrls = (id: number): string[] => [
  `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  `https://www.gutenberg.org/cache/epub/${id}/pg${id}-txt.utf8.txt`,
  `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
  `https://gutenberg.pglaf.org/${id}/${id}-0.txt`,
];

/** 내려받지 못해 건너뛴 책 (리뷰 3-1: 조용히 빠진 채 덮어쓰지 않게 알린다) */
const failedBooks: string[] = [];

async function downloadAll(): Promise<void> {
  if (LANES.includes("daily")) {
    console.log("· 일상 회화(Tatoeba) 내려받는 중…");
    try {
      bytesQueue.daily = await cachedBytes("kor-eng.zip", [DAILY_URL]);
    } catch (e) {
      // classic 레인은 책마다 안내하고 daily는 그대로 죽어 일관성이 없었다(리뷰 2-6).
      console.error(
        `  ✗ 일상 회화 원본(kor-eng.zip)을 준비하지 못했습니다. ` +
          `네트워크가 닿지 않는 환경에서는 원본을 미리 ${join(CACHE_DIR, "kor-eng.zip")} 에 두은 뒤 --offline 으로 다시 실행하세요.` +
          ` (${e instanceof Error ? e.message : String(e)})`,
      );
      throw e;
    }
  }
  if (LANES.includes("classic")) {
    for (const book of BOOKS) {
      if (!book.gutenberg) continue;
      console.log(`· ${book.title} 내려받는 중…`);
      try {
        bytesQueue.books.set(
          book.id,
          await cachedBytes(
            `pg${book.gutenberg}.txt`,
            pgUrls(book.gutenberg),
            isCompleteGutenbergText,
          ),
        );
      } catch (e) {
        console.log(`  ✗ ${book.title}: ${e instanceof Error ? e.message : e}`);
        failedBooks.push(book.title);
      }
    }
  }
}

/** 난이도 비율을 맞춰 남은 문장을 고른다. */function shuffleWithSeed<T>(list: T[], seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 쉬움/보통/어려움 비율을 유지하며 cap개만 남긴다 (짧은 문장만 쌓이는 것 방지) */
const RATIO: Record<string, number> = {
  easy: 0.3,
  normal: 0.45,
  hard: 0.25,
};

export function balanceByDifficulty(
  entries: CorpusEntry[],
  cap: number,
  seed: number,
  ratio: Record<string, number> = RATIO,
): CorpusEntry[] {
  if (entries.length <= cap) return entries;
  const want: Record<string, number> = {
    easy: Math.round(cap * (ratio.easy ?? 0)),
    normal: Math.round(cap * (ratio.normal ?? 0)),
    hard: Math.round(cap * (ratio.hard ?? 0)),
  };
  const pools = {
    easy: shuffleWithSeed(entries.filter((e) => e.difficulty === "easy"), seed),
    normal: shuffleWithSeed(entries.filter((e) => e.difficulty === "normal"), seed + 1),
    hard: shuffleWithSeed(entries.filter((e) => e.difficulty === "hard"), seed + 2),
  };
  const picked: CorpusEntry[] = [];
  // 모자란 수를 채울 때 picked.includes()는 선택 개수만큼 선형 검색이었다(리뷰 2-10).
  const pickedSet = new Set<CorpusEntry>();
  let left = cap;
  for (const key of ["hard", "normal", "easy"] as const) {
    const take = Math.min(want[key], pools[key].length, left);
    const taken = pools[key].slice(0, take);
    picked.push(...taken);
    for (const e of taken) pickedSet.add(e);
    left -= take;
  }
  // 모자란 수는 남은 풀에서 채운다
  if (left > 0) {
    const rest = shuffleWithSeed(
      entries.filter((e) => !pickedSet.has(e)),
      seed + 3,
    );
    picked.push(...rest.slice(0, left));
  }
  return picked;
}

function summarize(entries: CorpusEntry[]): string {
  const by = { easy: 0, normal: 0, hard: 0 };
  for (const e of entries) by[e.difficulty] += 1;
  return `쉬움 ${by.easy} / 보통 ${by.normal} / 어려움 ${by.hard}`;
}

/**
 * lane별로 어휘 빈도·백분위 기준선을 만들어 난이도와 힌트를 입힌다.
 * LLM 없이 결정론적으로 동작한다.
 */
function applyDifficultyAndHints(
  entries: CorpusEntry[],
  easyRatio: number,
  hardRatio: number,
): void {
  const sentences = entries.map((e) => e.en);
  const stats = buildFrequency(sentences);
  stats.gradeCutoffs = computeGradeCutoffs(sentences, stats, {
    easyRatio,
    hardRatio,
  });
  for (const e of entries) {
    e.difficulty = gradeDifficulty(e.en, stats);
    e.hints = pickHints(e.en, stats);
  }
}

/**
 * 코퍼스 파일을 자리에 덮어쓰기 전의 안전망 (리뷰 3-1).
 *
 * public/data/corpus/*.json은 사람이 옮긴 번역까지 담긴, 유일하게 추적되는 사본이다
 * (.corpus-cache/는 gitignore). 내려받기가 전부 실패한 빌드가 그 자리를 빈 파일로
 * 덮거나 수록 조합이 크게 바뀐 파일로 덮으면, 되돌릴 수단이 없다.
 */
export const MIN_RETAIN_RATIO = 0.5;

/** 기존 파일의 entries 개수. 파일이 없거나 형식이 깨졌으면 null. */
function existingEntryCount(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.length : null;
  } catch {
    return null;
  }
}

/**
 * 쓰기를 거부해야 할 이유를 돌려주고, 괜찮으면 null을 돌려준다.
 * 0문장은 --force로도 쓸 수 없다. 기존 대비 급감은 --force로만 넘긴다.
 */
export function describeWriteProblem(
  lane: CorpusLane,
  path: string,
  nextCount: number,
  previousCount: number | null,
  force: boolean,
): string | null {
  if (nextCount === 0) {
    return (
      `${lane}: 수록 문장 0개 — 원본을 하나도 받지 못했습니다. ${path}을(를) 빈 코퍼스로 덮지 않습니다. ` +
      `네트워크를 확인한 뒤 다시 실행하거나, 원본을 .corpus-cache/에 받아두고 --offline 으로 다시 실행하세요.`
    );
  }
  if (previousCount !== null && nextCount < previousCount * MIN_RETAIN_RATIO) {
    const base =
      `${lane}: 수록 문장이 ${previousCount}개 → ${nextCount}개로 급감했습니다 ` +
      `(이전의 ${Math.round(MIN_RETAIN_RATIO * 100)}% 미만).`; // 기존 파일엔 사람 손으로 옮긴 번역이 있다
    return force
      ? null
      : `${base} 내려받기가 일부 실패한 것은 아닌지 확인하세요. 의도된 결과라면 --force 로 다시 실행하세요.`;
  }
  return null;
}

async function main(): Promise<void> {
  await downloadAll();

  const daily = LANES.includes("daily") ? buildDaily() : { entries: [], attribution: "" };
  const classic = LANES.includes("classic") ? buildClassic() : [];

  // lane별로 어휘 빈도와 백분위 기준선을 만들어 난이도·힌트를 입힌다.
  // (코퍼스 전체를 한 기준으로 보면 19세기 문체가 전부 어려움으로 몰린다)
  applyDifficultyAndHints(daily.entries, 0.32, 0.28);
  applyDifficultyAndHints(classic, 0.3, 0.3);

  const dailyEntries = balanceByDifficulty(daily.entries, DAILY_CAP, 20260101);
  const classicEntries = balanceByDifficulty(
    classic,
    CLASSIC_CAP,
    20260102,
    { easy: 0.3, normal: 0.4, hard: 0.3 },
  );
  if (daily.entries.length)
    console.log(`  (필터 통과 전체 ${daily.entries.length}: ${summarize(daily.entries)})`);

  if (WITH_LLM) {
    const env = llmFromEnv();
    if (!env) {
      console.log("! --llm에는 ENLEARN_LLM_HOST / _MODEL / _API_KEY 가 필요합니다.");
    } else {
      // 밸런싱 후 실제 수록되는 문장만 번역한다 (후보 전체를 번역하면 비용이 70% 이상 늘어난다)
      await fillKoreanTranslations(classicEntries, env);
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const generatedAt = new Date().toISOString();

  const dailyFile: CorpusFile = {
    lane: "daily",
    generatedAt,
    license: "CC-BY 2.0 (France)",
    attribution:
      "Tatoeba (tatoeba.org) — 문장별 id는 각 항목의 sourceId에 저장되어 있습니다.",
    sources: [{ id: "tatoeba", title: "Tatoeba 일상 회화", author: "tatoeba.org", count: dailyEntries.length }],
    entries: dailyEntries,
  };

  const classicFile: CorpusFile = {
    lane: "classic",
    generatedAt,
    license: "Public Domain (미국 저작권 만료 작품)",
    attribution: "Project Gutenberg (gutenberg.org)에서 받은 퍼블릭 도메인 원문",
    sources: sourcesFromClassic(classicEntries),
    entries: classicEntries,
  };

  // 요청하지 않은 레인의 파일을 빈 내용으로 덮어쓰지 않는다
  const writes: { lane: CorpusLane; path: string; body: string; count: number }[] = [];
  if (LANES.includes("daily")) {
    writes.push({
      lane: "daily",
      path: join(OUT_DIR, "daily.json"),
      body: JSON.stringify(dailyFile),
      count: dailyEntries.length,
    });
  }
  if (LANES.includes("classic")) {
    writes.push({
      lane: "classic",
      path: join(OUT_DIR, "classics.json"),
      body: JSON.stringify(classicFile),
      count: classicEntries.length,
    });
  }

  // 원본을 하나도 받지 못한 빌드가 사람 손으로 옮긴 번역을 빈 파일로 덮는다(리뷰 3-1).
  // 어느 레인이든 거부하면 쓰기를 전부 멈춘다 — 반쯤 바뀐 코퍼스는 더 추적하기 어렵다.
  const problems = writes
    .map((w) =>
      describeWriteProblem(w.lane, w.path, w.count, existingEntryCount(w.path), FORCE),
    )
    .filter((p): p is string => p !== null);
  if (problems.length > 0) {
    console.error("\n빌드를 멈춥니다 — 기존 코퍼스 파일은 그대로 둡니다:");
    for (const problem of problems) console.error(`  ! ${problem}`);
    process.exit(1);
  }

  // 두 파일 모두 tmp + rename로 쓴다. 두 번째 쓰기에서 죽어도 기존 두 파일은 그대로다(R4-1).
  for (const w of writes) writeAtomic(w.path, w.body);

  console.log("\n코퍼스 빌드 완료");
  console.log(`  💬 일상 회화: ${dailyEntries.length}문장 — ${summarize(dailyEntries)}`);
  console.log(`  (동화 후보 전체 ${classic.length}: ${summarize(classic)})`);
  console.log(`  📖 동화 명문장: ${classicEntries.length}문장 — ${summarize(classicEntries)}`);
  console.log(`  → ${join("public", "data", "corpus")}`);

  // 일부 책이 빠진 채로 쓰였다면 "성공"으로 끝내지 않는다 (리뷰 3-1).
  if (failedBooks.length > 0) {
    console.log(
      `\n! 내려받지 못한 책 ${failedBooks.length}권 — 이번 코퍼스는 일부 책 없이 만들어졌습니다.`,
    );
    for (const title of failedBooks) console.log(`  · ${title}`);
    console.log(
      "  네트워크를 확인한 뒤 다시 실행하거나, 원본을 .corpus-cache/에 받아두고 --offline 으로 다시 실행하세요.",
    );
    process.exit(1);
  }
}

// 이 파일을 직접 실행할 때만 빌드를 돌린다 (테스트에서는 순수 함수만 가져온다)
if (invokedDirectly) {
  // 예외를 그대로 두면 unhandled rejection + 스택 트레이스로 끝난다.
  // 사용자에게 필요한 것은 원인과 다음 조치 한 줄이다(리뷰 2-6).
  main().catch((e: unknown) => {
    console.error(`빌드 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

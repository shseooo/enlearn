/**
 * 코퍼스 빌드 스크립트.
 *
 *   npm run corpus                 # 두 레인 모두
 *   npm run corpus -- --lane=daily # 일상 회화만
 *   npm run corpus -- --offline    # 이미 받아둔 원문으로 다시 정제만
 *   npm run corpus -- --llm        # 동화 문장에 한국어 번역/힌트를 미리 입혀둠
 *
 * 원본 내려받기는 .corpus-cache/ 에 저장하므로 재실행 시 네트워크를 쓰지 않는다.
 * 결과물은 public/data/corpus/{daily,classics}.json
 */
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CorpusEntry,
  CorpusFile,
  CorpusLane,
  CorpusSourceInfo,
} from "../src/lib/types.ts";
import {
  buildFrequency,
  gradeDifficulty,
  isPracticeSentence,
  normalizeKey,
  normalizeProse,
  pickHints,
  splitSentences,
  stripGutenbergBoilerplate,
  stripWikisourceMarkup,
} from "../src/lib/corpus-tools.ts";

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

const LANES: CorpusLane[] = (() => {
  const lane = flag("lane", "all");
  if (lane === "daily") return ["daily"];
  if (lane === "classic") return ["classic"];
  return ["daily", "classic"];
})();
const OFFLINE = argv.includes("--offline");
const WITH_LLM = argv.includes("--llm");
const PER_BOOK = Number(flag("per-book", "180"));
const DAILY_CAP = Number(flag("daily-cap", "3000"));
const CLASSIC_CAP = Number(flag("classic-cap", "1400"));
const ROOT = process.cwd();
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

async function fetchBytes(url: string, attempts = 3): Promise<Buffer> {
  let lastError = "알 수 없는 오류";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
      } else {
        return Buffer.from(await res.arrayBuffer());
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    const wait = 1500 * (i + 1);
    console.log(`  ↻ 실패(${lastError}) ${wait}ms 후 재시도`);
    await sleep(wait);
  }
  throw new Error(`${url} 내려받기 실패: ${lastError}`);
}

/** 원본은 캐시에 저장해 두므로 재실행 시 네트워크를 쓰지 않는다. */
async function cachedBytes(name: string, urls: string[]): Promise<Buffer> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, name);
  if (existsSync(path)) return readFileSync(path);
  if (OFFLINE) throw new Error(`캐시에 없음(--offline): ${name}`);

  let error: Error | null = null;
  for (const url of urls) {
    try {
      const buf = await fetchBytes(url);
      writeFileSync(path, buf);
      await sleep(1200); // 사이트 배려: 요청 사이에 쉬는 시간
      return buf;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
      console.log(`  ✗ ${url} — ${error.message}`);
    }
  }
  throw error ?? new Error(name);
}

/** 외부 프로그램 없이 zip을 푼다 (stored/deflate만 지원). */
function unzipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 구조를 읽을 수 없습니다(EOCD 없음).");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: { name: string; data: Buffer }[] = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 일상 회화 레인 (Tatoeba 한↔영어)
// ---------------------------------------------------------------------------

function hasHangul(text: string): boolean {
  return /[\u3131-\uD79D]/.test(text);
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
    if (!hasHangul(koText)) continue;
    if (koText.length < 4 || koText.length > 80) continue;
    if (!/[.!?…]$/.test(koText)) continue;

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
  const apiKey = process.env.ENLEARN_LLM_API_KEY ?? "";
  return host && model && apiKey ? { host, model, apiKey } : null;
}

async function translateToKorean(
  env: LlmEnv,
  sentence: string,
): Promise<{ ko: string; hints: string[] }> {
  const base = env.host.replace(/\/+$/, "");
  const url = base.endsWith("/chat/completions")
    ? base
    : `${base.endsWith("/v1") ? base : `${base}/v1`}/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify({
      model: env.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            '오늘 배울 영어 문장을 한국어 학습자에게 보여준다. ' +
            '반드시 {"ko":"현재 한국어로 자연스러운 번역","hints":["핵심 영어 단어 2~4개"]} JSON만 출력해라. ' +
            "ko는 문어체 고어투가 아니라 요즘 쓰는 자연스러운 한국어로 옮겨라. hints는 영어만.",
        },
        { role: "user", content: `영어 문장: """${sentence}"""` },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("JSON 없음");
  const parsed = JSON.parse(match[0]) as { ko?: unknown; hints?: unknown };
  const ko = typeof parsed.ko === "string" ? parsed.ko.trim() : "";
  if (!hasHangul(ko)) throw new Error("한국어 없음");
  const hints = Array.isArray(parsed.hints)
    ? parsed.hints.filter((h): h is string => typeof h === "string").slice(0, 4)
    : [];
  return { ko, hints };
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

async function downloadAll(): Promise<void> {
  if (LANES.includes("daily")) {
    console.log("· 일상 회화(Tatoeba) 내려받는 중…");
    bytesQueue.daily = await cachedBytes("kor-eng.zip", [DAILY_URL]);
  }
  if (LANES.includes("classic")) {
    for (const book of BOOKS) {
      if (!book.gutenberg) continue;
      console.log(`· ${book.title} 내려받는 중…`);
      try {
        bytesQueue.books.set(
          book.id,
          await cachedBytes(`pg${book.gutenberg}.txt`, pgUrls(book.gutenberg)),
        );
      } catch (e) {
        console.log(`  ✗ ${book.title}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

/** 난이도 비율을 맞춰 남은 문장을 고른다. */
function shuffleWithSeed<T>(list: T[], seed: number): T[] {
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
  easy: 0.35,
  normal: 0.45,
  hard: 0.2,
};

function balanceByDifficulty(
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
  let left = cap;
  for (const key of ["hard", "normal", "easy"] as const) {
    const take = Math.min(want[key], pools[key].length, left);
    picked.push(...pools[key].slice(0, take));
    left -= take;
  }
  // 모자란 수는 남은 풀에서 채운다
  if (left > 0) {
    const rest = shuffleWithSeed(
      entries.filter((e) => !picked.includes(e)),
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

async function main(): Promise<void> {
  await downloadAll();

  const daily = LANES.includes("daily") ? buildDaily() : { entries: [], attribution: "" };
  const classic = LANES.includes("classic") ? buildClassic() : [];

  // 코퍼스 전체 어휘 빈도로 난이도와 힌트를 정한다 (LLM 불필요, 결정론적)
  const stats = buildFrequency([
    ...daily.entries.map((e) => e.en),
    ...classic.map((e) => e.en),
  ]);
  for (const e of [...daily.entries, ...classic]) {
    e.difficulty = gradeDifficulty(e.en, stats);
    e.hints = pickHints(e.en, stats);
  }

  const dailyEntries = balanceByDifficulty(daily.entries, DAILY_CAP, 20260101);
  const classicEntries = balanceByDifficulty(
    classic,
    CLASSIC_CAP,
    20260102,
    { easy: 0.22, normal: 0.4, hard: 0.38 },
  );
  if (daily.entries.length)
    console.log(`  (필터 통과 전체 ${daily.entries.length}: ${summarize(daily.entries)})`);

  if (WITH_LLM) {
    const env = llmFromEnv();
    if (!env) {
      console.log("! --llm에는 ENLEARN_LLM_HOST / _MODEL / _API_KEY 가 필요합니다.");
    } else {
      const target = classic.filter((e) => !e.ko);
      console.log(`· 동화 ${target.length}개 문장에 한국어 번역 입히는 중…`);
      for (const e of target) {
        try {
          const { ko, hints } = await translateToKorean(env, e.en);
          e.ko = ko;
          if (hints.length) e.hints = hints;
        } catch (err) {
          console.log(`  ! 번역 실패(건너뜀): ${e.en.slice(0, 40)} — ${err instanceof Error ? err.message : err}`);
        }
      }
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
  if (LANES.includes("daily")) {
    writeFileSync(join(OUT_DIR, "daily.json"), JSON.stringify(dailyFile));
  }
  if (LANES.includes("classic")) {
    writeFileSync(join(OUT_DIR, "classics.json"), JSON.stringify(classicFile));
  }

  console.log("\n코퍼스 빌드 완료");
  console.log(`  💬 일상 회화: ${dailyEntries.length}문장 — ${summarize(dailyEntries)}`);
  console.log(`  (동화 후보 전체 ${classic.length}: ${summarize(classic)})`);
  console.log(`  📖 동화 명문장: ${classicEntries.length}문장 — ${summarize(classicEntries)}`);
  console.log(`  → ${join("public", "data", "corpus")}`);
}

await main();

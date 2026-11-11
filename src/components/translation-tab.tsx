"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CorpusEntry,
  CorpusFile,
  CorpusLane,
  Difficulty,
  EvaluationResult,
  LLMSettings,
} from "@/lib/types";
import {
  DIFFICULTY_LABELS,
  evaluateTranslation,
  generateKoreanExercise,
  translateSentenceToKorean,
} from "@/lib/llm";
import {
  cacheKorean,
  LANE_LABELS,
  loadCorpus,
  markSeen,
  pickEntry,
  resolveKorean,
  sourcesOf,
} from "@/lib/corpus";
import { entryKey, DIFFICULTY_SHORT } from "@/lib/corpus-tools";
import { logPractice } from "@/lib/practice";
import { isSettingsComplete } from "@/lib/settings";
import { useCancellable } from "@/lib/use-cancellable";
import EvaluationCard from "./evaluation-card";
import SettingsWarning from "./settings-warning";

/** 문장 출처: 코퍼스(사람이 쓴 문장) 또는 AI 생성 */
type SourceMode = CorpusLane | "ai";

// 코퍼스 레인 이름은 corpus.ts의 LANE_LABELS를 그대로 쓴다 (이중 정의 방지)
const MODE_LABELS: Record<SourceMode, string> = {
  daily: `${LANE_LABELS.daily} (Tatoeba)`,
  classic: `${LANE_LABELS.classic} (책)`,
  ai: "✨ AI가 문장 만들기",
};

/** 책 드롭다운에 쓰는 항목 (출처별 문장 수) */
type BookOption = { id: string; title: string; count: number };

interface TranslationTabProps {
  settings: LLMSettings;
  onGoSettings: () => void;
}

/** 📝 번역 연습: 사람이 쓴 문장을 영어로 옮기고 평가받는다. (문장을 직접 창작하지 않는다) */
export default function TranslationTab({
  settings,
  onGoSettings,
}: TranslationTabProps) {
  const [mode, setMode] = useState<SourceMode>("daily");
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [topic, setTopic] = useState("");
  const [bookId, setBookId] = useState("all");
  const [sources, setSources] = useState<BookOption[]>([]);

  const [entry, setEntry] = useState<CorpusEntry | null>(null);
  const [korean, setKorean] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [koFromLlm, setKoFromLlm] = useState(false);
  const [recycled, setRecycled] = useState(false);

  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [evaluated, setEvaluated] = useState<{
    korean: string;
    english: string;
  } | null>(null);

  const isCorpus = mode !== "ai";

  /**
   * 진행 중인 요청과 화면 결과를 구분하는 토큰
   * (문장을 먼저 바꾼 뒤 이전 평가 응답이 늦게 도착하면 다른 문장 위에 덮어써진다)
   */
  const requestSeq = useRef(0);
  const { begin, cancel } = useCancellable();

  // 책 드롭다운에 제목을 채우기 위해 코퍼스 목록을 미리 읽어둔다.
  useEffect(() => {
    if (mode !== "classic") return;
    let alive = true;
    loadCorpus("classic")
      .then((file) => {
        if (alive) setSources(sourcesOf(file));
      })
      .catch(() => {
        if (alive) setSources([]);
      });
    return () => {
      alive = false;
    };
  }, [mode]);

  const canPick =
    !picking && !loading && (isCorpus || isSettingsComplete(settings));
  const canEvaluate =
    isSettingsComplete(settings) &&
    !picking &&
    korean.length > 0 &&
    answer.trim().length > 0 &&
    !loading;

  /**
   * 코퍼스에서 아직 안 풀어본 문장을 하나 꺼낸다. (동화는 첫 한국어만 LLM 번역)
   * ⚠️ 여기서 markSeen/cacheKorean 같은 쓰기를 하지 않는다. 호출자가 "이 응답을
   * 적용할 시점인지" 확인한 뒤에만 기록해야, 취소·출처 변경으로 사라진 문장이
   * 영구 소진되지 않는다.
   */
  async function fetchFromCorpus(
    lane: CorpusLane,
    signal: AbortSignal,
  ): Promise<{
    item: CorpusEntry;
    key: string;
    ko: string;
    hints: string[];
    fromLlm: boolean;
    recycled: boolean;
    file: CorpusFile;
  }> {
    const file = await loadCorpus(lane, signal);
    const picked = pickEntry(file, {
      difficulty,
      sourceId: lane === "classic" ? bookId : undefined,
    });
    if (!picked) {
      throw new Error(
        "이 조건에 맞는 문장이 코퍼스에 없습니다. 터미널에서 npm run corpus 를 실행해 보세요.",
      );
    }

    const item = picked.entry;
    const key = entryKey(item);
    let ko = resolveKorean(item);
    let nextHints = item.hints;
    let fromLlm = false;

    if (!ko) {
      if (!isSettingsComplete(settings)) {
        throw new Error(
          "동화 문장은 첫 한국어 번역에 LLM이 필요합니다. ⚙️ 설정에서 host/model을 입력하세요.",
        );
      }
      const translated = await translateSentenceToKorean(settings, item.en, {
        signal,
      });
      ko = translated.sentence;
      if (!nextHints.length) nextHints = translated.hints;
      fromLlm = true;
    }

    return {
      item,
      key,
      ko,
      hints: nextHints,
      fromLlm,
      recycled: picked.recycled,
      file,
    };
  }

  /** 문장·평가 상태를 한 번에 정리한다. (입력 중인 영어 답안은 살린다) */
  function clearSentence() {
    setEntry(null);
    setKorean("");
    setHints([]);
    setKoFromLlm(false);
    setRecycled(false);
    setResult(null);
    setEvaluated(null);
    setError(null);
  }

  async function handleGetSentence() {
    // 진행 중인 평가·문장 받기 결과를 버린다
    const seq = ++requestSeq.current;
    const stale = () => seq !== requestSeq.current;
    const { signal } = begin();
    setPicking(true);
    setPickError(null);
    setResult(null);
    setEvaluated(null);
    setError(null);
    try {
      if (mode === "ai") {
        const next = await generateKoreanExercise(settings, difficulty, topic, {
          signal,
        });
        if (stale() || signal.aborted) return;
        setEntry(null);
        setKorean(next.sentence);
        setHints(next.hints);
        setKoFromLlm(false);
        setRecycled(false);
      } else {
        const picked = await fetchFromCorpus(mode, signal);
        // 취소·출처 변경 뒤에 도착한 응답은 화면에도, 기록에도 손대지 않는다
        if (stale() || signal.aborted) return;
        if (picked.fromLlm) cacheKorean(picked.key, picked.ko, picked.hints);
        markSeen(picked.key);
        setEntry(picked.item);
        setKorean(picked.ko);
        setHints(picked.hints);
        setKoFromLlm(picked.fromLlm);
        setRecycled(picked.recycled);
        setSources(sourcesOf(picked.file));
      }
      if (!stale()) setAnswer("");
    } catch (e) {
      if (stale() || signal.aborted) return;
      // 실패하면 문장 상태를 완전히 비운다. entry/hints를 남기면
      // 지난 문장의 평가 카드가 새 출처 라벨로 그대로 보인다. (사용자 입력은 살린다)
      clearSentence();
      setPickError(
        e instanceof Error ? e.message : "문장을 가져오는 중 오류가 발생했습니다.",
      );
    } finally {
      if (!stale()) setPicking(false);
    }
  }

  async function handleEvaluate() {
    if (!korean) return;
    const english = answer.trim();
    const seq = ++requestSeq.current;
    const stale = () => seq !== requestSeq.current;
    const { signal } = begin();
    setLoading(true);
    setError(null);
    try {
      const r = await evaluateTranslation(settings, korean, english, entry?.en, {
        signal,
      });
      if (stale() || signal.aborted) return;
      // 코퍼스 연습에서는 참고 번역 자리에 "실제 출판된 문장"을 보여준다.
      const finalResult: EvaluationResult = entry
        ? { ...r, referenceTranslation: entry.en }
        : r;
      setResult(finalResult);
      setEvaluated({ korean, english });
      // 연습 기록: 대시보드·복습 큐의 재료가 된다 (코퍼스 문장만 복습에 들어간다)
      logPractice({
        lane: mode,
        en: entry?.en ?? finalResult.referenceTranslation ?? "",
        ko: korean,
        answer: english,
        score: finalResult.score,
        corrections: finalResult.corrections.map((c) => ({
          original: c.original,
          better: c.better,
        })),
      });
    } catch (e) {
      if (stale() || signal.aborted) return;
      setResult(null);
      setError(e instanceof Error ? e.message : "평가 중 오류가 발생했습니다.");
    } finally {
      if (!stale()) setLoading(false);
    }
  }

  const referenceLabel =
    mode === "classic"
      ? "📖 명문장 (책 원문)"
      : mode === "daily"
        ? "📖 원문 (Tatoeba)"
        : "📖 참고 번역";

  const referenceNote = entry
    ? entry.lane === "classic"
      ? `출처: ${entry.source}`
      : `Tatoeba 문장 #${entry.sourceId ?? "-"}`
    : undefined;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label
          htmlFor="sentence-source"
          className="mb-1.5 block text-sm font-semibold text-slate-700"
        >
          문장 출처
        </label>
        <select
          id="sentence-source"
          value={mode}
          onChange={(e) => {
            // 출처를 바꾸면 진행 중인 요청 결과를 버리고 문장을 정리한다.
            // (Tatoeba 원문이 AI 모드로 바뀐 뒤에도 "📖 참고 번역"으로 보였던 문제)
            requestSeq.current += 1;
            cancel();
            setMode(e.target.value as SourceMode);
            setBookId("all");
            setPickError(null);
            clearSentence();
          }}
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
        >
          <option value="daily">{MODE_LABELS.daily}</option>
          <option value="classic">{MODE_LABELS.classic}</option>
          <option value="ai">{MODE_LABELS.ai}</option>
        </select>

        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {mode === "ai"
            ? "AI가 문장을 직접 만듭니다. (문장이 어색할 수 있습니다)"
            : "실제 사람이 쓴 문장입니다. 한국어만 영어로 옮기면 됩니다."}
        </p>

        {mode === "classic" && (
          <>
            <label
              htmlFor="sentence-book"
              className="mt-4 mb-1.5 block text-sm font-semibold text-slate-700"
            >
              책
            </label>
            <select
              id="sentence-book"
              value={bookId}
              onChange={(e) => setBookId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            >
              <option value="all">전체 책에서 골고루</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({s.count})
                </option>
              ))}
            </select>
          </>
        )}

        {mode === "ai" && (
          <>
            <label
              htmlFor="sentence-topic"
              className="mt-4 mb-1.5 block text-sm font-semibold text-slate-700"
            >
              주제 <span className="font-normal text-slate-400">(선택)</span>
            </label>
            <input
              id="sentence-topic"
              type="text"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="예: 여행, 직장, 날씨, 건강 — 비우면 자유 주제"
              className="w-full rounded-xl border border-slate-300 p-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label
            htmlFor="difficulty"
            className="text-sm font-semibold text-slate-700"
          >
            난이도
          </label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          >
            <option value="easy">{DIFFICULTY_LABELS.easy}</option>
            <option value="normal">{DIFFICULTY_LABELS.normal}</option>
            <option value="hard">{DIFFICULTY_LABELS.hard}</option>
          </select>
        </div>

        <button
          type="button"
          onClick={handleGetSentence}
          disabled={!canPick}
          className="mt-4 w-full rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {picking ? "문장 가져오는 중..." : "📝 문장 받기"}
        </button>

        {isCorpus && (
          <p className="mt-2 text-xs text-slate-400">
            한 번 받은 문장은 기록되어 다시 나오지 않습니다.
          </p>
        )}

        {picking && (
          <div className="mt-3 flex items-center justify-center gap-3 text-sm text-slate-500">
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
            />
            <span role="status">문장을 가져오고 있어요...</span>
            <button
              type="button"
              onClick={cancel}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              취소
            </button>
          </div>
        )}

        {pickError && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <strong>오류:</strong> {pickError}
          </div>
        )}
      </div>

      {korean && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">
              아래 문장을 영어로 번역하세요
            </h3>
            <button
              type="button"
              onClick={handleGetSentence}
              disabled={picking || loading}
              className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-50"
            >
              🔄 다시 받기
            </button>
          </div>
          <p className="rounded-xl bg-slate-50 p-4 text-lg font-medium text-slate-800">
            {korean}
          </p>

          {entry && (
            <p className="mt-1.5 text-xs text-slate-400">
              {entry.source}
              {entry.difficulty !== difficulty &&
                ` · 난이도 ${DIFFICULTY_SHORT[entry.difficulty]}`}
              {koFromLlm && " · 한국어는 AI가 영어 원문에서 번역한 것"}
              {recycled && " · 이미 푼 문장이 다시 나왔습니다"}
            </p>
          )}

          {hints.length > 0 && (
            <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-600 transition hover:text-indigo-700">
                💡 힌트 단어 {hints.length}개 보기
              </summary>
              <div className="flex flex-wrap gap-2 px-3 pb-3">
                {hints.map((h) => (
                  <span
                    key={h}
                    className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-800"
                  >
                    {h}
                  </span>
                ))}
              </div>
            </details>
          )}

          <label
            htmlFor="translation-answer"
            className="mt-4 mb-2 block text-sm font-semibold text-slate-700"
          >
            내 영어 번역
          </label>
          <textarea
            id="translation-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder="여기에 영어 번역을 입력하세요"
            className="w-full resize-y rounded-xl border border-slate-300 p-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={handleEvaluate}
              disabled={!canEvaluate}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {loading ? "평가 중..." : "점수 받기"}
            </button>
          </div>
        </div>
      )}

      {!isSettingsComplete(settings) && (
        <SettingsWarning onGoSettings={onGoSettings} />
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          <strong>오류:</strong> {error}
        </div>
      )}

      {loading && (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
          />
          <span role="status">LLM이 번역을 평가하고 있어요...</span>
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            취소
          </button>
        </div>
      )}

      {!loading && result && evaluated && (
        <EvaluationCard
          result={result}
          settings={settings}
          context={{ original: evaluated.korean, answer: evaluated.english }}
          referenceLabel={referenceLabel}
          referenceNote={referenceNote}
        />
      )}
    </div>
  );
}

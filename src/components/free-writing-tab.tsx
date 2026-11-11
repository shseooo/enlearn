"use client";

import { useRef, useState } from "react";
import type { LLMSettings, EvaluationResult } from "@/lib/types";
import { isSettingsComplete } from "@/lib/settings";
import { evaluateFreeWriting } from "@/lib/llm";
import { useCancellable } from "@/lib/use-cancellable";
import { logPractice } from "@/lib/practice";
import EvaluationCard from "./evaluation-card";
import SettingsWarning from "./settings-warning";

interface FreeWritingTabProps {
  settings: LLMSettings;
  onGoSettings: () => void;
}

/** ✍️ 자유 작성: 영어 문장을 입력하면 LLM이 점수 + 피드백 + 개선안을 반환 */
export default function FreeWritingTab({
  settings,
  onGoSettings,
}: FreeWritingTabProps) {
  const [sentence, setSentence] = useState("");
  const [evaluatedSentence, setEvaluatedSentence] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const { begin, cancel } = useCancellable();
  // 어떤 호출의 결과를 적용할지 정는 번호. 취소·새 요청 모두 여기서 걸러진다.
  const requestSeq = useRef(0);

  const canSubmit =
    isSettingsComplete(settings) && sentence.trim().length > 0 && !loading;

  async function handleSubmit() {
    const trimmed = sentence.trim();
    if (!trimmed) return;
    const seq = ++requestSeq.current;
    const stale = () => seq !== requestSeq.current;
    const { signal } = begin();
    setLoading(true);
    setError(null);
    try {
      const r = await evaluateFreeWriting(settings, trimmed, { signal });
      if (stale() || signal.aborted) return;
      setResult(r);
      setEvaluatedSentence(trimmed);
      logPractice({
        lane: "free",
        en: trimmed,
        ko: null,
        answer: trimmed,
        score: r.score,
        corrections: r.corrections.map((c) => ({
          original: c.original,
          better: c.better,
        })),
      });
    } catch (e) {
      // 취소(사용자·새 요청으로 인한 것)는 오류로 표시하지 않는다
      if (stale() || signal.aborted) return;
      setResult(null);
      setError(e instanceof Error ? e.message : "평가 중 오류가 발생했습니다.");
    } finally {
      if (!stale()) setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label
          htmlFor="free-sentence"
          className="mb-2 block text-sm font-semibold text-slate-700"
        >
          영문으로 문장을 작성해보세요
        </label>
        <textarea
          id="free-sentence"
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
          rows={4}
          placeholder="예: Yesterday I go to the park with my friends."
          className="w-full resize-y rounded-xl border border-slate-300 p-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-slate-400">
            {sentence.trim() ? `${sentence.trim().length}자 입력됨` : "문장을 입력하세요"}
          </span>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? "평가 중..." : "점수 받기"}
          </button>
        </div>
      </div>

      {!isSettingsComplete(settings) && (
        <SettingsWarning onGoSettings={onGoSettings} />
      )}

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
        >
          <strong>오류:</strong> {error}
        </div>
      )}

      {loading && (
        <div className="flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
          />
          <span role="status">LLM이 문장을 평가하고 있어요...</span>
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
          >
            취소
          </button>
        </div>
      )}

      {!loading && result && (
        <EvaluationCard
          // 작성 문장이 바뀌면 카드가 새로 마운트된다(추가 질문 히스토리 격리)
          key={evaluatedSentence}
          result={result}
          settings={settings}
          context={{ original: evaluatedSentence }}
        />
      )}
    </div>
  );
}


"use client";

import { useEffect, useRef, useState } from "react";
import type {
  EvaluationContext,
  EvaluationResult,
  FollowUpTurn,
  LLMSettings,
} from "@/lib/types";
import { isSettingsComplete } from "@/lib/settings";
import { askFollowUp } from "@/lib/llm";
import { useCancellable } from "@/lib/use-cancellable";
import ScoreGauge, { scoreVerdict } from "./score-gauge";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 언마운트 후에 setCopied가 호출되지 않도록 타이머를 정리한다
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setCopied(false);
      }, 1500);
    } catch {
      // 클립보드 API가 차단된 환경에서는 무시
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
    >
      {copied ? "복사됨 ✓" : "복사"}
    </button>
  );
}

/** LLM 평가 결과를 카드 형태로 표시한다. (추가 질문 포함) */
export default function EvaluationCard({
  result,
  settings,
  context,
  referenceLabel = "📖 참고 번역",
  referenceNote,
}: {
  result: EvaluationResult;
  settings: LLMSettings;
  context: EvaluationContext;
  /** 코퍼스 연습에서는 "명문장(원전)" 처럼 제목을 바꾼다. */
  referenceLabel?: string;
  /** 출처 표기 (책/저자/Tatoeba id) */
  referenceNote?: string;
}) {
  const [history, setHistory] = useState<FollowUpTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { begin, cancel } = useCancellable();

  const canAsk = isSettingsComplete(settings) && input.trim().length > 0 && !loading;

  async function handleSubmit() {
    const question = input.trim();
    if (!question) return;
    const { signal, isCurrent } = begin();
    setLoading(true);
    setError(null);
    try {
      const answer = await askFollowUp(settings, context, result, question, history, {
        signal,
      });
      if (!isCurrent()) return;
      setHistory((h) => [...h, { question, answer }]);
      setInput("");
    } catch (e) {
      if (!isCurrent() || signal.aborted) return;
      setError(e instanceof Error ? e.message : "질문 처리 중 오류가 발생했습니다.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  return (
    <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-5">
        <ScoreGauge score={result.score} />
        <div className="min-w-0">
          <p className="text-lg font-bold text-slate-800">
            {scoreVerdict(result.score)}
          </p>
          {result.feedback && (
            <p className="mt-1 text-sm leading-relaxed text-slate-600">
              {result.feedback}
            </p>
          )}
        </div>
      </div>

      {result.corrections.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            🔧 개선할 표현
          </h3>
          <ul className="space-y-2">
            {result.corrections.map((c, i) => (
              <li
                key={`${c.original}|${c.better}|${i}`}
                className="rounded-lg bg-slate-50 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {c.original && (
                    <span className="text-rose-600 line-through decoration-rose-300">
                      {c.original}
                    </span>
                  )}
                  {c.better && (
                    <>
                      <span className="text-slate-400">→</span>
                      <span className="font-semibold text-emerald-700">
                        {c.better}
                      </span>
                    </>
                  )}
                </div>
                {c.reason && <p className="mt-1 text-slate-500">{c.reason}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.referenceTranslation && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            {referenceLabel}
          </h3>
          <blockquote className="rounded-lg border-l-4 border-indigo-300 bg-indigo-50/50 p-3 text-sm font-medium text-slate-700">
            {result.referenceTranslation}
          </blockquote>
          {referenceNote && (
            <p className="mt-1 text-xs text-slate-400">{referenceNote}</p>
          )}
        </div>
      )}

      {result.betterExpression && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">
              ✨ 더 좋은 전체 표현
            </h3>
            <CopyButton text={result.betterExpression} />
          </div>
          <p className="rounded-lg bg-emerald-50 p-3 text-sm font-medium text-emerald-900">
            {result.betterExpression}
          </p>
        </div>
      )}

      <div className="border-t border-slate-100 pt-4">
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          💬 결과에 대해 추가 질문하기
        </h3>

        {history.length > 0 && (
          <div className="mb-3 space-y-3">
            {history.map((f, i) => (
              <div key={`${f.question}|${i}`} className="space-y-1 text-sm">
                <p className="font-medium text-indigo-700">Q. {f.question}</p>
                <p className="whitespace-pre-wrap leading-relaxed text-slate-700">
                  {f.answer}
                </p>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
          >
            <strong>오류:</strong> {error}
          </div>
        )}

        {loading && (
          <p role="status" className="mb-3 flex items-center gap-3 text-sm text-slate-500">
            <span
              aria-hidden
              className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
            />
            답변을 받고 있어요...
            <button
              type="button"
              onClick={cancel}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              취소
            </button>
          </p>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="예: 'went' 말고 비슷한 표현이 있을까요? / 왜 과거형이 필요한가요?"
            aria-label="추가 질문"
            disabled={loading}
            className="w-full rounded-xl border border-slate-300 p-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-50"
          />
          <button
            type="submit"
            disabled={!canAsk}
            className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {loading ? "답변 중..." : "질문하기"}
          </button>
        </form>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import type { EvaluationResult } from "@/lib/types";
import ScoreGauge, { scoreVerdict } from "./score-gauge";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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

/** LLM 평가 결과를 카드 형태로 표시한다. */
export default function EvaluationCard({ result }: { result: EvaluationResult }) {
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
              <li key={i} className="rounded-lg bg-slate-50 p-3 text-sm">
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
                {c.reason && (
                  <p className="mt-1 text-slate-500">{c.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.referenceTranslation && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            📖 참고 번역
          </h3>
          <blockquote className="rounded-lg border-l-4 border-indigo-300 bg-indigo-50/50 p-3 text-sm font-medium text-slate-700">
            {result.referenceTranslation}
          </blockquote>
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
    </div>
  );
}

"use client";

import { useState } from "react";
import type {
  Difficulty,
  EvaluationResult,
  KoreanExercise,
  LLMSettings,
} from "@/lib/types";
import {
  generateKoreanExercise,
  evaluateTranslation,
  DIFFICULTY_LABELS,
} from "@/lib/llm";
import { isSettingsComplete } from "@/lib/settings";
import EvaluationCard from "./evaluation-card";
import { SettingsWarning } from "./free-writing-tab";

interface TranslationTabProps {
  settings: LLMSettings;
  onGoSettings: () => void;
}

/** 📝 번역 연습: LLM이 만든 한국어 문장을 영어로 번역하고 평가받는다 */
export default function TranslationTab({
  settings,
  onGoSettings,
}: TranslationTabProps) {
  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [topic, setTopic] = useState("");
  const [exercise, setExercise] = useState<KoreanExercise | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationResult | null>(null);

  const canGenerate = isSettingsComplete(settings) && !generating;
  const canEvaluate =
    isSettingsComplete(settings) &&
    Boolean(exercise) &&
    answer.trim().length > 0 &&
    !loading;

  async function handleGetSentence() {
    setGenerating(true);
    setGenError(null);
    setResult(null);
    setError(null);
    try {
      const next = await generateKoreanExercise(settings, difficulty, topic);
      setExercise(next);
      setAnswer("");
    } catch (e) {
      setExercise(null);
      setGenError(
        e instanceof Error ? e.message : "문장 생성 중 오류가 발생했습니다.",
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleEvaluate() {
    if (!exercise) return;
    setLoading(true);
    setError(null);
    try {
      setResult(
        await evaluateTranslation(settings, exercise.sentence, answer.trim()),
      );
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "평가 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
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

        <button
          type="button"
          onClick={handleGetSentence}
          disabled={!canGenerate}
          className="mt-4 w-full rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {generating ? "문장 만드는 중..." : "📝 한국어 문장 받기"}
        </button>

        {genError && (
          <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <strong>오류:</strong> {genError}
          </div>
        )}
      </div>

      {exercise && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">
              아래 문장을 영어로 번역하세요
            </h3>
            <button
              type="button"
              onClick={handleGetSentence}
              disabled={generating}
              className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:opacity-50"
            >
              🔄 다시 받기
            </button>
          </div>
          <p className="rounded-xl bg-slate-50 p-4 text-lg font-medium text-slate-800">
            {exercise.sentence}
          </p>

          {exercise.hints.length > 0 && (
            <details className="mt-3 rounded-lg border border-slate-200 bg-slate-50">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-slate-600 transition hover:text-indigo-700">
                💡 힌트 단어 {exercise.hints.length}개 보기
              </summary>
              <div className="flex flex-wrap gap-2 px-3 pb-3">
                {exercise.hints.map((h) => (
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
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
          LLM이 번역을 평가하고 있어요...
        </div>
      )}

      {!loading && result && <EvaluationCard result={result} />}
    </div>
  );
}

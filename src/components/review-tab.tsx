"use client";

import { useState, useSyncExternalStore } from "react";
import {
  REVIEW_INTERVALS,
  dueItems,
  getPracticeServerSnapshot,
  getPracticeSnapshot,
  gradeReview,
  lastAnswerFor,
  subscribeToPractice,
  type ReviewGrade,
} from "@/lib/practice";
import { LANE_SHORT_LABELS, nextReviewDate } from "@/lib/practice";

const GRADES: { id: ReviewGrade; label: string; className: string }[] = [
  {
    id: "knows",
    label: "✓ 알고 있어요",
    className: "bg-emerald-600 hover:bg-emerald-700 text-white",
  },
  {
    id: "shaky",
    label: "~ 아슬아슬",
    className: "bg-amber-500 hover:bg-amber-600 text-white",
  },
  {
    id: "forgot",
    label: "✗ 잊었어요",
    className: "bg-rose-600 hover:bg-rose-700 text-white",
  },
];

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-center">
      <p className="text-lg font-bold text-slate-800">{value}</p>
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * 📆 복습 탭.
 * 푼 문장을 1/3/7/21/45일 뒤에 다시 내고, 자기 평가로 다음 복습 시점을 정한다.
 * LLM을 쓰지하므로 설정이 없어도 동작하고 즉시 결과가 나온다.
 */
export default function ReviewTab() {
  const snapshot = useSyncExternalStore(
    subscribeToPractice,
    getPracticeSnapshot,
    getPracticeServerSnapshot,
  );
  // 어떤 문장을 보고 있는지 id만 기억하고, 문장 자체는 렌더 중 파생시킨다
  // (effect로 setState 하면 캐스케이드 렌더가 생기므로 쓰지 않는다)
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 서버에서는 스냅샷이 0이므로 Date를 만드는 함수를 부르지 않는다.
  // (Next 16은 Client Component 렌더 중 new Date()를 불안정 값으로 잡아 prerender를 실패시킨다)
  const queue = snapshot.due > 0 ? dueItems() : [];
  const nextDue =
    snapshot.srs > 0 && snapshot.due === 0 ? nextReviewDate() : null;
  const current =
    (currentId ? queue.find((x) => x.id === currentId) : null) ??
    queue[0] ??
    null;

  function loadNext(excludeId?: string): void {
    const next = queue.filter((x) => x.id !== excludeId)[0];
    setCurrentId(next?.id ?? null);
    setAnswer("");
    setRevealed(false);
  }

  function handleGrade(grade: ReviewGrade) {
    if (!current) return;
    const updated = gradeReview(current.id, grade);
    if (updated) {
      const interval = REVIEW_INTERVALS[updated.stage];
      setMessage(
        grade === "shaky"
          ? `다음 복습: ${updated.due}`
          : `단계 ${updated.stage + 1} · 다음 복습: ${updated.due} (약 ${interval}일 뒤)`,
      );
    }
    loadNext(current.id);
  }

  const previousAnswer = current ? lastAnswerFor(current.id) : null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-800">
          📊 연습 현황
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="연속 연습"
            value={`${snapshot.streak}일`}
            hint={snapshot.streak > 0 ? "오늘도 풀면 이어집니다" : "오늘 시작해 보세요"}
          />
          <Metric label="오늘" value={`${snapshot.today}문장`} />
          <Metric label="이번 주" value={`${snapshot.week}문장`} />
          <Metric label="평균 점수" value={`${snapshot.avgScore}점`} />
        </div>
        <p className="mt-3 text-xs text-slate-500" role="status">
          복습 대기{" "}
          <strong className="font-semibold text-slate-700">{snapshot.due}</strong>개
          · 복습 큐 {snapshot.srs}개
        </p>
      </div>

      {current ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-700">
              다시 써보는 문장
            </h3>
            <button
              type="button"
              onClick={() => loadNext(current.id)}
              className="rounded-md px-2 py-1 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50"
            >
              🔄 다른 문장
            </button>
          </div>

          <p className="rounded-xl bg-slate-50 p-4 text-lg font-medium text-slate-800">
            {current.ko}
          </p>
          <p className="mt-1.5 text-xs text-slate-400">
            {LANE_SHORT_LABELS[current.lane]} · 복습 단계 {current.stage + 1}
            {current.lapses > 0 && ` · 놓친 횟수 ${current.lapses}`}
          </p>

          <label
            htmlFor="review-answer"
            className="mt-4 mb-2 block text-sm font-semibold text-slate-700"
          >
            기억나는 대로 영어로 써보세요
          </label>
          <textarea
            id="review-answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            placeholder="쓰지 않아도 됩니다. 머릿으로만 떠올려도 좋아요."
            className="w-full resize-y rounded-xl border border-slate-300 p-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
          />

          {revealed ? (
            <div className="mt-3 space-y-2">
              <div>
                <h4 className="mb-1 text-sm font-semibold text-slate-700">
                  📖 원문
                </h4>
                <blockquote className="rounded-lg border-l-4 border-indigo-300 bg-indigo-50/50 p-3 text-sm font-medium text-slate-700">
                  {current.en}
                </blockquote>
              </div>
              {previousAnswer && previousAnswer !== answer.trim() && (
                <p className="text-xs text-slate-500">
                  지난번 답: <span className="line-through">{previousAnswer}</span>
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1">
                {GRADES.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => handleGrade(g.id)}
                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${g.className}`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
              >
                정답 보기
              </button>
            </div>
          )}

        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          <p className="mb-1 font-semibold text-slate-700">
            {snapshot.srs > 0
              ? "오늘 복습할 문장은 없습니다"
              : "복습할 문장이 아직 없습니다"}
          </p>
          <p>
            {nextDue
              ? `다음 복습은 ${nextDue}부터 다시 시작됩니다.`
              : "📝 번역 연습에서 문장을 풀면 하루 뒤에 여기 돌아옵니다."}
          </p>
        </div>
      )}

      {snapshot.topMistakes.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">
            🔁 자주 틀리는 표현
          </h3>
          <ul className="space-y-2">
            {snapshot.topMistakes.map((m, i) => (
              <li key={`${m.original}-${i}`} className="rounded-lg bg-slate-50 p-3 text-sm">
                <span className="text-rose-600 line-through decoration-rose-300">
                  {m.original}
                </span>
                <span className="mx-2 text-slate-400">→</span>
                <span className="font-semibold text-emerald-700">{m.better}</span>
                <span className="ml-2 text-xs text-slate-400">{m.count}번</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            연습 기록에서 가장 자주 고쳐진 표현 상위 5개입니다.
          </p>
        </div>
      )}

      {/* 평점 결과는 다음 문장이 없어도 보이도록 카드 밖에 둔다 */}
      {message && (
        <p role="status" className="text-xs text-slate-500">
          {message}
        </p>
      )}
    </div>
  );
}

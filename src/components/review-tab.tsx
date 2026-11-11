"use client";

import {
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  LANE_SHORT_LABELS,
  REVIEW_INTERVALS,
  dueItems,
  getPracticeServerSnapshot,
  getPracticeSnapshot,
  gradeReview,
  lastAnswerFor,
  localToday,
  nextReviewDate,
  practiceStats,
  subscribeToPractice,
  weeklySeries,
  type ReviewGrade,
} from "@/lib/practice";
import { evaluateTranslation } from "@/lib/llm";
import { isSettingsComplete } from "@/lib/settings";
import { useCancellable } from "@/lib/use-cancellable";
import type { EvaluationResult, LLMSettings } from "@/lib/types";
import SettingsWarning from "./settings-warning";
import WeeklyChart from "./weekly-chart";

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

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
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
 * 원하면 LLM으로 쓴 문장을 채점받을 수도 있다(기본 흐름은 LLM 없이 동작한다).
 */
export default function ReviewTab({
  settings,
  onGoSettings,
}: {
  settings: LLMSettings;
  onGoSettings: () => void;
}) {
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
  // 채점 결과는 "어떤 문장의 결과인지" 함께 저장한다. 문장이 바뀌면 저절로 사라진다.
  const [score, setScore] = useState<{
    id: string;
    result: EvaluationResult;
  } | null>(null);
  const [scoreError, setScoreError] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [scoringId, setScoringId] = useState<string | null>(null);
  const { begin, cancel } = useCancellable();
  // 채점 결과·loading 적용은 호출 번호로 판단한다(취소해도 loading은 꺼야 한다)
  const requestSeq = useRef(0);

  // 서버 렌더에서는 Date를 읽는 계산을 하지 않는다 (Next 16이 불안정 값으로 잡는다).
  /**
   * 자정 재계산은 이 컴포넌트가 아니라 스냅샷이 책임진다(리뷰 1-13에서 만든
   * 자체 타이머는 리뷰 2-9에서 스토어로 올라간 뒤에도 남아 자정에 두 번 렌더하게 했다, 리뷰 4-7).
   * subscribeToPractice가 자정에 알림을 내고 getPracticeSnapshot이 로컬 날짜가
   * 바뀌면 새 참조를 만들어 주므로, 아래 derived는 snapshot만 보고도 새로 돈다.
   */
  // localStorage를 읽는 계산은 스냅샷이 바뀔 때만 한다.
  // 이 탭은 다른 탭에서 키를 입력할 때마다 다시 렌더되는데, 그때마다
  // 저장소를 몇 번씩 파싱하지 않는다(3-10).
  const derived = useMemo(() => {
    const has = snapshot.total > 0;
    // 저장소는 그대로여도 자정이 지나면 오늘/주간/대기 계산이 달라진다.
    // 날짜로 판정하는 값은 스냅샷(snapshot)이 다시 계산하므로 여기서 따라간다(리뷰 2-9).
    const stats = has ? practiceStats() : null;
    const queue = snapshot.srs > 0 ? dueItems() : [];
    return {
      today: has ? localToday() : "",
      todayCount: stats?.today ?? 0,
      streak: stats?.streak ?? 0,
      weeks: has ? weeklySeries(8) : [],
      queue,
      due: queue.length,
      nextDue:
        snapshot.srs > 0 && queue.length === 0 ? nextReviewDate() : null,
    };
  }, [snapshot]);
  const { today, todayCount, streak, weeks, queue, due, nextDue } = derived;
  const current =
    (currentId ? queue.find((x) => x.id === currentId) : null) ??
    queue[0] ??
    null;

  /**
   * "다른 문장"은 큐를 순환한다. (현재 것을 빼고 첫 항목)이면 A→B→A→B로 진동해서
   * 세 번째 문장부터 영영 보여지지 않는다(리뷰 3-5).
   */
  function loadNext(excludeId?: string): void {
    // 진행 중이던 채점은 새 문장에 쓸모가 없다. 그대로 두면 취소 단추는 사라지고
    // 응답은 id가 맞아떨어지지 않아 조용히 버려진다 — 토큰만 나간다(리뷰 2-8).
    requestSeq.current += 1;
    cancel();
    setScoringId(null);
    setScore(null);
    setScoreError(null);
    if (queue.length <= 1) {
      setCurrentId(null);
    } else {
      const at = queue.findIndex((x) => x.id === (excludeId ?? current?.id));
      const next = queue[((at < 0 ? 0 : at) + 1) % queue.length];
      setCurrentId(next.id);
    }
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

  async function handleScore() {
    if (!current || !answer.trim()) return;
    const id = current.id;
    const seq = ++requestSeq.current;
    const stale = () => seq !== requestSeq.current;
    const { signal } = begin();
    setScoringId(id);
    setScore(null);
    setScoreError(null);
    try {
      const result = await evaluateTranslation(
        settings,
        current.ko,
        answer.trim(),
        current.en,
        { signal },
      );
      if (stale() || signal.aborted) return;
      setScore({ id, result });
    } catch (e) {
      // 취소는 오류가 아니다 (직전 호출을 끊으면 abort가 터진다)
      if (stale() || signal.aborted) return;
      setScoreError({
        id,
        text: e instanceof Error ? e.message : "채점에 실패했습니다.",
      });
    } finally {
      if (!stale()) setScoringId(null);
    }
  }

  // 지난 답안은 memo 밖에서 부르면 렌더마다 연습 기록(최대 400개)을 다시 판다.
  // 지금 보는 문장이 바뀔 때만 계산한다(리뷰 1-12).
  const currentEntryId = current?.id ?? "";
  const previousAnswer = useMemo(
    () => (currentEntryId ? lastAnswerFor(currentEntryId) : null),
    // snapshot은 계산에 쓰지 않지만 "기록이 바뀜"을 아는 유일한 신호다(lastAnswerFor는 저장소를 읽는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentEntryId, snapshot],
  );
  const settingsOk = isSettingsComplete(settings);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-base font-bold text-slate-800">
          📊 연습 현황
        </h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric
            label="연속 연습"
            value={`${streak}일`}
            hint={
              streak > 0 ? "오늘도 풀면 이어집니다" : "오늘 시작해 보세요"
            }
          />
          <Metric label="오늘" value={`${todayCount}문장`} />
          <Metric label="이번 주" value={`${snapshot.week}문장`} />
          <Metric label="평균 점수" value={`${snapshot.avgScore}점`} />
        </div>
        <p className="mt-3 text-xs text-slate-500" role="status">
          복습 대기{" "}
          <strong className="font-semibold text-slate-700">{due}</strong>개
          · 복습 큐 {snapshot.srs}개
        </p>
        {weeks.length > 0 && (
          <div className="mt-4 border-t border-slate-100 pt-4">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">
              주간 연습량
            </h3>
            <WeeklyChart weeks={weeks} today={today} />
          </div>
        )}
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

          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {!settingsOk ? (
              <SettingsWarning onGoSettings={onGoSettings} />
            ) : (
              <button
                type="button"
                onClick={() => void handleScore()}
                disabled={!answer.trim() || scoringId === current.id}
                className="rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {scoringId === current.id ? "채점 중…" : "🎯 LLM 채점"}
              </button>
            )}
            {scoringId === current.id && (
              <button
                type="button"
                onClick={cancel}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50"
              >
                취소
              </button>
            )}
            {!revealed && (
              <button
                type="button"
                onClick={() => setRevealed(true)}
                className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
              >
                정답 보기
              </button>
            )}
          </div>

          {scoreError && scoreError.id === current.id && (
            <p role="alert" className="mt-2 text-xs text-rose-600">
              {scoreError.text}
            </p>
          )}

          {score && score.id === current.id && (
            <div className="mt-3 rounded-xl border border-slate-200 p-3">
              <p className="mb-2 text-sm font-semibold text-slate-700">
                🎯 채점 결과{" "}
                <span className="ml-1 text-base font-bold text-indigo-600">
                  {score.result.score}점
                </span>
              </p>
              <p className="text-sm leading-relaxed text-slate-600">
                {score.result.feedback}
              </p>
              {score.result.corrections.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {score.result.corrections.map((c, i) => (
                    <li
                      key={`${c.original}-${i}`}
                      className="rounded-lg bg-slate-50 p-2 text-xs"
                    >
                      <span className="text-rose-600 line-through decoration-rose-300">
                        {c.original}
                      </span>
                      <span className="mx-2 text-slate-400">→</span>
                      <span className="font-semibold text-emerald-700">
                        {c.better}
                      </span>
                      {c.reason && (
                        <span className="ml-2 text-slate-500">{c.reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {score.result.betterExpression && (
                <p className="mt-2 text-xs text-slate-500">
                  ✨ 더 좋은 표현:{" "}
                  <span className="font-medium text-slate-700">
                    {score.result.betterExpression}
                  </span>
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-400">
                복습 채점 점수는 연습 기록 집계(평균 점수)에 합산되지 않습니다.
              </p>
            </div>
          )}

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
            <div className="mt-1 text-xs text-slate-400">
              다 썼으면 정답을 보고 비교한 뒤, 아래 세 단추로 스스로 평가하세요.
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
              <li
                key={`${m.original}-${i}`}
                className="rounded-lg bg-slate-50 p-3 text-sm"
              >
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

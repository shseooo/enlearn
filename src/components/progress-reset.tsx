"use client";

import { useState, useSyncExternalStore } from "react";
import {
  batchProgress,
  clearKoreanCache,
  getProgressServerSnapshot,
  getProgressSnapshot,
  LANE_LABELS,
  resetSeen,
  subscribeToProgress,
} from "@/lib/corpus";
import type { CorpusLane } from "@/lib/types";
import {
  batchPractice,
  clearLog,
  clearSrs,
  getPracticeServerSnapshot,
  getPracticeSnapshot,
  subscribeToPractice,
} from "@/lib/practice";

/**
 * ⚙️ 설정 화면의 '연습 기록' 섹션.
 * 받은 문장 기록과 AI 한국어 번역 캐시를 보여주고 초기화할 수 있다.
 * (엉터리 번역이 한 번 캐시되면 스스로 고칠 방법이 없으므로 진입점이 필요하다)
 */

/**
 * 되돌릴 수 없는 삭제 모두에 같은 확인을 받는다(D1-1).
 * 한 클릭으로 seen 2만 건·번역 캐시 4천 건·연습 기록·복습 큐가 사라지고,
 * 되돌릴 수단은 사용자가 미리 내보낸 백업뿐이다.
 */
const CONFIRM_MESSAGE = "이 기록을 지웁니다 — 되돌릴 수 없습니다. 먼저 백업을 내보내세요. 계속할까요?";

export default function ProgressReset() {
  // localStorage를 외부 스토어로 구독한다 (서버 렌더 시에는 0 스냅샷)
  const counts = useSyncExternalStore(
    subscribeToProgress,
    getProgressSnapshot,
    getProgressServerSnapshot,
  );
  const practice = useSyncExternalStore(
    subscribeToPractice,
    getPracticeSnapshot,
    getPracticeServerSnapshot,
  );
  const [message, setMessage] = useState<string | null>(null);

  function resetPractice(what: "log" | "srs" | "both") {
    if (!window.confirm(CONFIRM_MESSAGE)) return;
    // 한 동작이 두 저장소를 바꾼다 — 백업 경로와 같은 묶음 쓰기로 알림을 한 번만 낸다(리뷰 3-14).
    batchPractice(() => {
      if (what !== "srs") clearLog();
      if (what !== "log") clearSrs();
    });
    setMessage(
      what === "log"
        ? "연습 기록(점수·자주 틀리는 표현)을 지웠습니다."
        : what === "srs"
          ? "복습 큐를 비웠습니다. 연습 기록은 그대로입니다."
          : "연습 기록과 복습 큐를 모두 지웠습니다.",
    );
  }

  function reset(lane: CorpusLane | "all", what: "seen" | "korean" | "both") {
    if (!window.confirm(CONFIRM_MESSAGE)) return;
    batchProgress(() => {
      if (what !== "korean") resetSeen(lane === "all" ? undefined : lane);
      if (what !== "seen") clearKoreanCache(lane === "all" ? undefined : lane);
    });
    const scope = lane === "all" ? "전체" : LANE_LABELS[lane];
    setMessage(
      what === "seen"
        ? `${scope} 받은 문장 기록을 지웠습니다.`
        : what === "korean"
          ? `${scope} 한국어 번역 캐시를 지웠습니다.`
          : `${scope} 연습 기록과 번역 캐시를 지웠습니다.`,
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-base font-bold text-slate-800">연습 기록</h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        받은 문장 기록과 AI가 번역한 한국어는 이 브라우저에만 저장됩니다. 기록을
        지우면 같은 문장이 다시 나올 수 있고, 번역 캐시를 지우면 동화 문장의
        한국어를 새로 번역합니다.
      </p>

      <ul className="mb-4 space-y-1 text-sm text-slate-600">
        <li>
          {LANE_LABELS.daily} — 받은 문장{" "}
          <strong className="font-semibold text-slate-800">{counts.daily}</strong>
          개
        </li>
        <li>
          {LANE_LABELS.classic} — 받은 문장{" "}
          <strong className="font-semibold text-slate-800">{counts.classic}</strong>
          개 · 한국어 번역 캐시{" "}
          <strong className="font-semibold text-slate-800">{counts.korean}</strong>
          개
        </li>
      </ul>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => reset("daily", "seen")}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
        >
          💬 회화 기록 지우기
        </button>
        <button
          type="button"
          onClick={() => reset("classic", "seen")}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
        >
          📖 동화 기록 지우기
        </button>
        <button
          type="button"
          onClick={() => reset("classic", "korean")}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
        >
          🔄 한국어 번역 캐시 지우기
        </button>
        <button
          type="button"
          onClick={() => reset("all", "both")}
          className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
        >
          전체 초기화
        </button>
      </div>

      <h2 className="mt-6 mb-1 text-base font-bold text-slate-800">
        연습 기록 · 복습 큐
      </h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        점수를 받은 문장과 자주 틀리는 표현, 간격반복(SRS) 큐입니다. 위의 받은
        문장 기록과 별개라서, 이를 지워도 같은 문장이 다시 나오지는 않습니다.
      </p>

      <ul className="mb-4 space-y-1 text-sm text-slate-600">
        <li>
          연습 기록{" "}
          <strong className="font-semibold text-slate-800">{practice.total}</strong>개
          · 평균 <strong className="font-semibold text-slate-800">{practice.avgScore}</strong>점
          · 연속 <strong className="font-semibold text-slate-800">{practice.streak}</strong>일
        </li>
        <li>
          복습 큐{" "}
          <strong className="font-semibold text-slate-800">{practice.srs}</strong>개 ·
          오늘 대기{" "}
          <strong className="font-semibold text-slate-800">{practice.due}</strong>개
        </li>
      </ul>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => resetPractice("log")}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
        >
          🗑 연습 기록 지우기
        </button>
        <button
          type="button"
          onClick={() => resetPractice("srs")}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
        >
          🗑 복습 큐 비우기
        </button>
        <button
          type="button"
          onClick={() => resetPractice("both")}
          className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
        >
          연습 기록 + 복습 큐 초기화
        </button>
      </div>

      {message && (
        <p role="status" className="mt-3 text-xs text-slate-500">
          {message}
        </p>
      )}
    </div>
  );
}

import type { WeekBucket } from "@/lib/practice";

/**
 * 주간 연습량 그래프. (최근 n주, 월요일 시작)
 * 점수는 막대 위에 숫자로, 문장 수는 막대 높이로 보여준다.
 */
export default function WeeklyChart({
  weeks,
  today,
}: {
  weeks: WeekBucket[];
  today: string;
}) {
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const summaryId = "weekly-chart-summary";

  return (
    <div>
      <ul
        // ⚠️ role="img"를 주면 하위가 표현용(presentational)이 되어 주별
        // aria-label이 읽히지 않는다. 목록 그대로 두고 설명은 describedby로 준다(리뷰 1-18).
        aria-label="주간 연습량"
        aria-describedby={summaryId}
        className="flex items-stretch gap-1"
      >
        {weeks.map((w) => {
          const isCurrent = today >= w.start && today <= w.end;
          const height = Math.round((w.count / max) * 100);
          return (
            // title은 툴팁이라 키보드·스크린리더로 못 읽는다 → 같은 내용을
            // focus 가능한 항목의 접근 가능한 이름으로 제공한다.
            <li
              key={w.start}
              tabIndex={0}
              aria-label={`${w.start} ~ ${w.end} · ${w.count}문장 · 평균 ${w.avgScore}점 · 교정 ${w.mistakes}개`}
              className="flex min-w-0 flex-1 flex-col items-center outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
              <span className="mb-0.5 text-[10px] font-semibold text-slate-500">
                {w.count > 0 ? w.count : ""}
              </span>
              <div
                className="flex h-24 w-full items-end rounded bg-slate-100"
                title={`${w.start} ~ ${w.end} · ${w.count}문장 · 평균 ${w.avgScore}점 · 교정 ${w.mistakes}개`}
              >
                <div
                  className={`w-full rounded-t ${isCurrent ? "bg-indigo-500" : "bg-indigo-300"}`}
                  style={{ height: `${w.count === 0 ? 0 : Math.max(height, 6)}%` }}
                />
              </div>
              <span
                className={`mt-1 truncate text-[10px] ${isCurrent ? "font-bold text-indigo-600" : "text-slate-400"}`}
              >
                {w.label}
              </span>
              <span className="text-[10px] text-slate-400">
                {w.count > 0 ? `${w.avgScore}점` : "-"}
              </span>
            </li>
          );
        })}
      </ul>
      <p id={summaryId} className="mt-2 text-xs text-slate-400">
        막대는 그 주에 연습한 문장 수, 아래 숫자는 평균 점수입니다. 진한 막대는
        진행 중인 주입니다.
      </p>
    </div>
  );
}

"use client";

/** LLM 설정이 완성되지 않았을 때 모든 탭이 공통으로 보여주는 배너 */
export default function SettingsWarning({
  onGoSettings,
}: {
  onGoSettings: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
      <span>LLM 설정이 아직 완성되지 않았어요.</span>
      <button
        type="button"
        onClick={onGoSettings}
        className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-600"
      >
        설정하러 가기
      </button>
    </div>
  );
}

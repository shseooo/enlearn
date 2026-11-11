"use client";

import { useEffect } from "react";

/**
 * 화면 하나가 죽어도 앱 전체가 꺼지지 않게 잡는 경계.
 * 사용자 입력(이상한 백업 파일 등)으로 예외가 터지면 여기서 정리하고 다시 시도한다.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[enlearn] 화면 렌더 실패:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl p-8 text-center">
      <h2 className="mb-2 text-lg font-bold text-slate-800">
        화면을 그리는 중에 문제가 생겼습니다
      </h2>
      <p className="mb-4 text-sm leading-relaxed text-slate-500">
        입력한 내용이나 파일이 원인일 수 있습니다. 다시 시도하면 처음부터 다시
        그립니다. 연습 기록은 그대로 남아 있습니다.
      </p>
      <pre className="mb-4 overflow-x-auto rounded-xl bg-slate-50 p-3 text-left text-xs text-slate-500">
        {error.message || "알 수 없는 오류"}
      </pre>
      <button
        type="button"
        onClick={reset}
        className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
      >
        다시 시도
      </button>
    </div>
  );
}

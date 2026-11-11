"use client";

import { useSyncExternalStore } from "react";
import { clearStorageError, storageError, subscribeToStorageError } from "@/lib/storage";

/**
 * 저장 실패(용량 초과 등)를 화면에 알려준다.
 * 쓰기는 삼키고 예외만 남기지 않는 구조라서, 안내가 없으면 사용자는
 * "방금 푼 문장이 왜 안 쌓이나"를 알 방법이 없다.
 *
 * 모든 탭 위에 한 번만 마운트한다(page.tsx). 문장을 받고 점수를 받는 탭에서
 * 쓰기가 일어나는데 안내는 복습 탭에만 있었기 때문이다(리뷰 1-8).
 */
export default function StorageWarning() {
  const message = useSyncExternalStore(
    subscribeToStorageError,
    storageError,
    () => null,
  );
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
    >
      <span>⚠️ {message}</span>
      <button
        type="button"
        onClick={clearStorageError}
        className="rounded-lg border border-amber-300 px-2 py-1 text-xs font-medium text-amber-800 transition hover:bg-amber-100"
      >
        닫기
      </button>
    </p>
  );
}

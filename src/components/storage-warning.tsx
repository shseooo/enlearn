"use client";

import { storageError } from "@/lib/storage";

/**
 * 저장 실패(용량 초과 등)를 화면에 알려준다.
 * 쓰기는 삼키고 예외만 남기지 않는 구조라서, 안내가 없으면 사용자는
 * "방금 푼 문장이 왜 안 쌓이나"를 알 방법이 없다.
 */
export default function StorageWarning() {
  const message = storageError();
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
    >
      ⚠️ {message}
    </p>
  );
}

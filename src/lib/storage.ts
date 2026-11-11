/**
 * localStorage 쓰기 방어.
 *
 * 브라우저 저장소에는 용량 한도(보통 5MB)가 있고, 넘기면 setItem이
 * QuotaExceededError를 던진다. 그 예외가 이벤트 핸들러까지 번지면
 * 화면이 죽는다(연습 기록을 쌓다 갑자기 버튼이 안 눌리는 것처럼 보인다).
 *
 * 여기서는 실패를 삼키고 "실패했다는 사실"만 남긴다. 이전 값은 그대로 남아 있다.
 */
let lastError: string | null = null;

export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    lastError = null;
    return true;
  } catch (err) {
    const quota =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    lastError = quota
      ? "브라우저 저장 공간이 가득 찼습니다. 설정 → 연습 기록을 정리해 주세요."
      : "브라우저에 저장하지 못했습니다.";
    return false;
  }
}

export function storageError(): string | null {
  return lastError;
}

export function clearStorageError(): void {
  lastError = null;
}

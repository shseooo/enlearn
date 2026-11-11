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
    if (lastError !== null) {
      lastError = null;
      notifyStorageChange();
    }
    return true;
  } catch (err) {
    const quota =
      err instanceof DOMException &&
      (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED");
    lastError = quota
      ? "브라우저 저장 공간이 가득 찼습니다. 설정 → 연습 기록을 정리해 주세요."
      : "브라우저에 저장하지 못했습니다.";
    notifyStorageChange();
    return false;
  }
}

export function storageError(): string | null {
  return lastError;
}

/**
 * 저장 실패/회복을 화면에 알리기 위한 변경 이벤트 (리뷰 1-8).
 * safeSetItem은 예외를 삼키므로, 안내는 이 이벤트로만 발표된다.
 */
const STORAGE_ERROR_EVENT = "enlearn:storage-error";

function notifyStorageChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(STORAGE_ERROR_EVENT));
}

/** 스냅샷이 바뀐 것을 계기로 알림을 다시 그린다 (useSyncExternalStore용) */
export function subscribeToStorageError(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(STORAGE_ERROR_EVENT, callback);
  return () => window.removeEventListener(STORAGE_ERROR_EVENT, callback);
}

export function clearStorageError(): void {
  if (lastError === null) return;
  lastError = null;
  notifyStorageChange();
}

// ---------------------------------------------------------------------------
// 파싱 결과 재사용 (리뷰 1-6)
// ---------------------------------------------------------------------------

/**
 * key별로 "마지막으로 읽은 문자열 + 파싱 결과"를 기억한다.
 * seen(최대 20,000개)·번역 캐시(4,000개)처럼 큰 저장소를 렌더/쓰기마다
 * 통째로 JSON.parse 하는 비용을 줄인다. 값은 호출자가 고치지 않도록 freeze한다.
 */
const parseCache = new Map<string, { raw: string; value: unknown }>();

/** 저장소에 들어있지 않거나 형식이 맞지 않으면 null을 돌려준다. */
export function parseStored<T>(
  key: string,
  raw: string | null,
  accept: (value: unknown) => boolean,
): T | null {
  if (raw === null) return null;
  const hit = parseCache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  try {
    const value: unknown = JSON.parse(raw);
    if (!accept(value)) return null;
    parseCache.set(key, { raw, value: Object.freeze(value) });
    return value as T;
  } catch {
    // 깨진 값은 무시하고 호출자가 기본값을 쓰게 한다
    return null;
  }
}

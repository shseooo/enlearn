import { useCallback, useRef } from "react";

/**
 * 진행 중인 LLM 호출을 취소할 수 있게 AbortController를 관리한다.
 *
 * - begin(): 새 호출의 signal과 "아직 유효한 호출인지" 판정을 돌려준다.
 * - cancel(): 현재 호출을 끊는다. (컴포넌트에서 signal.aborted로 취소와 오류를 구분한다)
 */
export function useCancellable(): {
  begin: () => { signal: AbortSignal; isCurrent: () => boolean };
  cancel: () => void;
} {
  const current = useRef<AbortController | null>(null);

  const begin = useCallback(() => {
    // 이전 호출이 남아 있으면 항상 끊는다 (늦은 응답이 화면을 덮지 못하게)
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    return {
      signal: controller.signal,
      isCurrent: () => current.current === controller,
    };
  }, []);

  const cancel = useCallback(() => {
    current.current?.abort();
  }, []);

  return { begin, cancel };
}

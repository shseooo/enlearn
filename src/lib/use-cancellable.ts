import { useCallback, useRef } from "react";

/**
 * 진행 중인 LLM 호출을 취소할 수 있게 AbortController를 관리한다.
 *
 * - begin(): 새 호출의 signal과 "이 호출이 아직 최신인지" 판정을 돌려준다.
 * - cancel(): 현재 호출을 끊고 최신 호출 자리를 비운다.
 *   → 취소 뒤에는 isCurrent()가 false다. 이전에는 true로 남아
 *   "취소"와 "더 새로운 요청으로 대체됨"을 구분할 수 없었다.
 *
 * 화면의 loading 정리는 isCurrent()로 하지 말고 호출 seq로 판단한다.
 * 취소한 요청도 loading은 꺼야 하기 때문이다. 표준 패턴:
 *   const seq = ++seqRef.current;
 *   const stale = () => seq !== seqRef.current;
 *   성공·실패 모두 `if (stale() || signal.aborted) return;`
 *   finally는 `if (!stale()) setLoading(false);`
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
    const controller = current.current;
    if (!controller) return;
    current.current = null; // 취소는 "최신 호출" 자리를 비운다 (isCurrent() → false)
    controller.abort();
  }, []);

  return { begin, cancel };
}

import { useCallback, useEffect, useRef } from "react";

/**
 * 진행 중인 LLM 호출을 취소할 수 있게 AbortController를 관리한다.
 *
 * - begin(): 새 호출의 signal과 "이 호출이 아직 최신인지" 판정을 돌려준다.
 * - cancel(): 현재 호출을 끊고 최신 호출 자리를 비운다.
 *   → 취소 뒤에는 isCurrent()가 false다. 이전에는 true로 남아
 *   "취소"와 "더 새로운 요청으로 대체됨"을 구분할 수 없었다.
 * - 화면이 unmount되면 진행 중이던 호출을 자동으로 끊는다(리뷰 3-9).
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

  // 화면이 unmount되면 진행 중이던 호출을 끊는다. 카드가 사라진 뒤에도
  // 요청이 예산(240초)까지 달리면 비용만 나가고 응답은 버려진다(리뷰 3-9).
  // cancel()과 달리 자리는 비우지 않는다 — 다시 마운트돼도 begin()이 새 제어기를 만든다.
  useEffect(() => {
    return () => current.current?.abort();
  }, []);

  return { begin, cancel };
}

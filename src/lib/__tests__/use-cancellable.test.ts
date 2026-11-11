import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCancellable } from "../use-cancellable";

describe("useCancellable", () => {
  it("새 begin()이 이전 호출을 끊고, 이전 호출은 더 이상 최신이 아니다", () => {
    const { result } = renderHook(() => useCancellable());
    const first = result.current.begin();
    const second = result.current.begin();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("cancel()은 요청을 끊고 '최신 호출' 자리도 비운다 (리뷰 3-2)", () => {
    const { result } = renderHook(() => useCancellable());
    const first = result.current.begin();

    act(() => result.current.cancel());

    expect(first.signal.aborted).toBe(true);
    // 취소와 "더 새로운 요청으로 대체됨"을 구분할 수 있어야 한다
    expect(first.isCurrent()).toBe(false);
  });

  it("취소 후에도 새 호출은 정상적으로 시작된다", () => {
    const { result } = renderHook(() => useCancellable());
    result.current.begin();
    act(() => result.current.cancel());

    const next = result.current.begin();
    expect(next.signal.aborted).toBe(false);
    expect(next.isCurrent()).toBe(true);
  });

  it("진행 중인 호출이 없으면 cancel()은 아무것도 하지 않는다", () => {
    const { result } = renderHook(() => useCancellable());
    expect(() => act(() => result.current.cancel())).not.toThrow();
  });
});

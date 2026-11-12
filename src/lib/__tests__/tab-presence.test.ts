/**
 * 다른 탭 감지(D3-1/R6-5). 같은 browser profile을 쓰면 localStorage 저장이
 * read-merge-write라 서로의 쓰기를 덮는다. 이 감지는 알림만 한다 — 대량은 D3-1에서
 * "하지 않음"으로 결정됐다(잠금·병합을 다시 요구하지 말 것).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TAB_CHANNEL, watchOtherTabs } from "../tab-presence";

describe("watchOtherTabs", () => {
  const channels: BroadcastChannel[] = [];

  /** 다른 탭을 흉내내는 채널 하나를 만든다. */
  function peer(): BroadcastChannel {
    const ch = new BroadcastChannel(TAB_CHANNEL);
    channels.push(ch);
    return ch;
  }

  /** BroadcastChannel 메시지는 비대기적으로 도착한다 — 다음 매크로태스크까지 기다린다. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    for (const ch of channels.splice(0)) ch.close();
  });

  it("다른 탭이 들어오면 개수를 알리고 나가면 0으로 돌아온다", async () => {
    const onChange = vi.fn();
    const stop = watchOtherTabs(onChange);
    try {
      const other = peer();
      other.postMessage({ type: "join", id: "peer-1" });
      await settle();
      expect(onChange).toHaveBeenLastCalledWith(1);

      other.postMessage({ type: "leave", id: "peer-1" });
      await settle();
      expect(onChange).toHaveBeenLastCalledWith(0);
    } finally {
      stop();
    }
  });

  it("들어온 탭은 서로를 바로 안다 — 먼저 열려 있던 쪽이 join에 답한다 (here)", async () => {
    const first = vi.fn();
    const stopFirst = watchOtherTabs(first);
    await settle();
    try {
      const second = vi.fn();
      const stopSecond = watchOtherTabs(second);
      try {
        await settle();
        // 첫 탭은 두 번째의 join에 here로 답하고, 두 번째는 첫 탭의 join을 봤다.
        expect(first).toHaveBeenLastCalledWith(1);
        expect(second).toHaveBeenLastCalledWith(1);
      } finally {
        stopSecond();
      }
      await settle();
      expect(first).toHaveBeenLastCalledWith(0);
    } finally {
      stopFirst();
    }
  });

  it("시작 즉시 현재 개수(0)를 알린다 — 배너는 이 값으로 숨겨진다", () => {
    const onChange = vi.fn();
    const stop = watchOtherTabs(onChange);
    try {
      expect(onChange).toHaveBeenCalledWith(0);
    } finally {
      stop();
    }
  });

  it("알 수 없는 형태의 메시지는 무시한다", async () => {
    const onChange = vi.fn();
    const stop = watchOtherTabs(onChange);
    try {
      onChange.mockClear(); // 등록 때 알린 0은 별개다
      peer().postMessage({ type: "join" }); // id 없음
      peer().postMessage({ type: "chat", id: "x", text: "상관없는 메시지" });
      peer().postMessage("문자열 메시지");
      await settle();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it(".cleanup을 부르면 상대방의 here를 세지 않는다", async () => {
    const onChange = vi.fn();
    const stop = watchOtherTabs(onChange);
    onChange.mockClear();
    stop();
    peer().postMessage({ type: "join", id: "peer-late" });
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });
});

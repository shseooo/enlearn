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

  /*
   * R7-4: leave는 정상 종료만 알린다. 크래시·강제 종료로 leave가 없으면
   * 배너 개수가 영구히 낡아 "없는 탭을 세는" 상태가 남는다.
   * ⚠️ peer 유예(peerTtlMs)는 heartbeat와 분리됐으므로(R8-3) 테스트에서도 따로 준다.
   */
  it("leave 없이 peer 채널만 닫아도 TTL 뒤에 개수가 0으로 돌아온다 (R7-4)", async () => {
    const onChange = vi.fn();
    const stop = watchOtherTabs(onChange, { heartbeatMs: 20, peerTtlMs: 40 });
    try {
      const other = peer();
      other.postMessage({ type: "join", id: "peer-crash" });
      await settle();
      expect(onChange).toHaveBeenLastCalledWith(1);

      other.close(); // 크래시 흉내 — leave를 보낼 기회가 없었다
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(onChange).toHaveBeenLastCalledWith(0);
    } finally {
      stop();
    }
  });

  /*
   * R8-3: peer TTL을 heartbeat 두 배로 두면, 배경 탭의 스로틀링된 heartbeat(최소 1분)
   * 보다 먼저 peer가 사라져 배너가 **꺼진다**. 경고가 꺼지는 방향은 켜지는 방향보다
   * 위험하므로 기본 유예를 주기보다 훨씬 길게 잡는다.
   */
  it("heartbeat 네 주기만큼 소식이 없어도 peer를 놓지 않는다 (R8-3)", async () => {
    const onChange = vi.fn();
    // heartbeat 20ms, 유예는 기본값(max(40ms, 120_000ms)) — 실제 브라우저의
    // "주기가 늦게 도착하는" 상황을 흉내낸다.
    const stop = watchOtherTabs(onChange, { heartbeatMs: 20 });
    try {
      const other = peer();
      other.postMessage({ type: "join", id: "peer-throttled" });
      await settle();
      expect(onChange).toHaveBeenLastCalledWith(1);

      onChange.mockClear();
      // 이전 TTL(heartbeat × 2 = 40ms)이라면 여기서 peer가 사라졌을 것이다.
      await new Promise((resolve) => setTimeout(resolve, 200));
      other.postMessage({ type: "here", id: "peer-throttled" }); // 늦게 도착한 heartbeat
      await settle();
      expect(onChange).not.toHaveBeenCalledWith(0);
    } finally {
      stop();
    }
  });

  // R8-3: visibilitychange는 timer 스로틀링을 받지 않는다 — peer 관측 시각을 갱신한다.
  it("visibilitychange가 peer를 계속 보이게 한다 (R8-3)", async () => {
    const first = vi.fn();
    const second = vi.fn();
    // heartbeat를 아주 길게 두면 재공지 경로는 visibilitychange만 남는다.
    const stopFirst = watchOtherTabs(first, { heartbeatMs: 100_000, peerTtlMs: 120 });
    const stopSecond = watchOtherTabs(second, { heartbeatMs: 100_000, peerTtlMs: 120 });
    try {
      await settle();
      expect(first).toHaveBeenLastCalledWith(1);
      expect(second).toHaveBeenLastCalledWith(1);

      // visibilitychange는 100ms 간격으로 보내는 동안 peer는 살아 있어야 한다.
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        document.dispatchEvent(new Event("visibilitychange"));
        await settle();
      }
      expect(first).toHaveBeenLastCalledWith(1);
      expect(second).toHaveBeenLastCalledWith(1);
    } finally {
      stopFirst();
      stopSecond();
    }
  });

  it("bfcache로 돌아오면(pageshow) 다시 이름을 알린다 (R7-4)", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = watchOtherTabs(first);
    const stopSecond = watchOtherTabs(second);
    try {
      await settle();
      expect(first).toHaveBeenLastCalledWith(1);
      expect(second).toHaveBeenLastCalledWith(1);

      // bfcache 진입: pagehide가 발화하고 상대는 우리를 peer에서 지운다.
      window.dispatchEvent(new Event("pagehide"));
      await settle();
      expect(first).toHaveBeenLastCalledWith(0);
      expect(second).toHaveBeenLastCalledWith(0);

      // bfcache 복원: 재공지가 없으면 두 탭이 동시에 쓰는 중인데 배너는 꺼져 있다.
      window.dispatchEvent(new Event("pageshow"));
      await settle();
      expect(first).toHaveBeenLastCalledWith(1);
      expect(second).toHaveBeenLastCalledWith(1);
    } finally {
      stopFirst();
      stopSecond();
    }
  });
});

/**
 * 같은 앱이 다른 탭(창)에서도 열려 있는지 알려주는 감지 (D3-1).
 *
 * 저장은 "전체 읽기 → 병합 → 전체 쓰기"(src/lib/practice.ts의 writeArray,
 * src/lib/corpus.ts의 markSeen)라, 두 탭이 동시에 연습하면 마지막 쓰기가
 * 상대의 기록을 통째로 덮어쓴다. 저장 형식·버전 락은 그대로 두고(D3-1 결정),
 * 사용자에게 사실만 알린다.
 *
 * ⚠️ BroadcastChannel은 "다른 탭이 열려 있다"는 사실만 전한다. 저장을 조율하지
 * 않는다 — 그래서 화면에 배너로만 쓴다.
 */

export const TAB_CHANNEL = "enlearn:tab";

type PresenceMessage = { type: "join" | "here" | "leave"; id: string };

function isPresenceMessage(value: unknown): value is PresenceMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.type === "join" || v.type === "here" || v.type === "leave") &&
    typeof v.id === "string"
  );
}

let nextId = 0;

/** 재공지 주기(ms). 이 주기로 "here"를 보낸다(R7-4). */
export const TAB_HEARTBEAT_MS = 15_000;

/**
 * peer를 살아있다고 보는 기간 하한(R8-3).
 *
 * ⚠️ heartbeat는 setInterval 한 갈래라 브라우저가 배경 탭에서 심하게 늦어진다
 * (숨긴 탭의 타이머는 1분 이하로 스로틀링되고 Page Lifecycle의 frozen 상태는 정지).
 * TTL을 주기의 두 배로 두면 숨긴 지 30초 지난 탭이 peer에서 사라져 배너가 **꺼진다**
 * — 실제로는 두 탭이 여전히 같은 저장소를 read-merge-write로 덮어쓰는 중이다.
 * 경고가 꺼지는 방향이 켜지는 방향보다 위험하므로(R7-4 주석), 관측 유예를 주기보다
 * 충분히 길게 잡는다. 정상 종료는 pagehide→leave가 즉시 알리므로 유예를 기다리지 않는다.
 */
export const TAB_PEER_TTL_MS = 120_000;

/** 테스트 등으로 주기를 조정할 수 있는 선택지 */
export interface WatchOptions {
  heartbeatMs?: number;
  /** peer 유예 기간 하한(ms). 기본은 max(heartbeatMs * 2, TAB_PEER_TTL_MS) */
  peerTtlMs?: number;
}

/**
 * 다른 탭이 살아 있는 동안 호출된다. 인자는 "다른 탭의 개수".
 * 지원되지 않는 환경(구 브라우저·SSR)에서는 아무것도 하지 않는 빈 cleanup을 돌려준다.
 */
export function watchOtherTabs(
  onChange: (others: number) => void,
  options: WatchOptions = {},
): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  const heartbeatMs = options.heartbeatMs ?? TAB_HEARTBEAT_MS;
  // 유예 기간은 heartbeat 주기에서 분리한다(R8-3): 배경 탭의 heartbeat는 늦게 도착한다.
  const peerTtlMs = options.peerTtlMs ?? Math.max(heartbeatMs * 2, TAB_PEER_TTL_MS);
  // 같은 탭의 자기 메시지는 무시하지만, id가 겹치면 다른 탭을 놓친다.
  // randomUUID가 없는 환경에서도 유일하도록 난수 + 증가 번호를 함께 쓴다.
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++nextId}`;
  const channel = new BroadcastChannel(TAB_CHANNEL);
  // peer id → 마지막 관측 시각. leave를 놓친 탭(크래시·강제 종료)은 TTL로 걷어낸다.
  const peers = new Map<string, number>();

  const post = (type: PresenceMessage["type"]): void => {
    try {
      channel.postMessage({ type, id } satisfies PresenceMessage);
    } catch {
      // 채널이 이미 닫힌 경우 등 — 안내를 잃는 것보다 낫다.
    }
  };

  channel.onmessage = (event: MessageEvent) => {
    const message = event.data;
    if (!isPresenceMessage(message) || message.id === id) return;
    if (message.type === "leave") {
      peers.delete(message.id);
    } else {
      peers.set(message.id, Date.now());
      // 새로 들어온 탭에게 "여기 있다"는 것을 알려준다(먼저 열린 탭은 join을 기다리지 않는다).
      if (message.type === "join") post("here");
    }
    onChange(peers.size);
  };

  const announceLeave = (): void => post("leave");
  // ⚠️ pagehide는 bfcache 진입(백그라운드·뒤로가기)에서도 발화한다. 그때 살아남은
  // 탭은 pageshow로 돌아오므로 다시 이름을 알린다(R7-4). 재공지와 TTL이 없으면
  // 배너 개수가 영구히 낡아 "낡은 사실"을 알려준다 — 경고가 꺼지는 방향은 특히 위험하다.
  const announceJoin = (): void => post("join");
  // 화면이 가리거나(bfcache·탭 전환) 다시 보이는 visibilitychange는 timer 스로틀링을
  // 받지 않으므로, heartbeat를 기다리지 않고 관측 시각을 갱신한다(R8-3).
  // 숨길 때 한 번도 보내면 그 시점부터 유예 기간이 늘어난다.
  const reannounce = (): void => post("here");
  const doc = typeof document === "undefined" ? null : document;
  window.addEventListener("pagehide", announceLeave);
  window.addEventListener("pageshow", announceJoin);
  doc?.addEventListener("visibilitychange", reannounce);
  const beat = window.setInterval(() => {
    post("here");
    const cutoff = Date.now() - peerTtlMs;
    let dropped = false;
    for (const [peerId, seenAt] of peers) {
      if (seenAt < cutoff) {
        peers.delete(peerId);
        dropped = true;
      }
    }
    if (dropped) onChange(peers.size);
  }, heartbeatMs);

  post("join");
  onChange(peers.size);

  return () => {
    window.clearInterval(beat);
    window.removeEventListener("pagehide", announceLeave);
    window.removeEventListener("pageshow", announceJoin);
    doc?.removeEventListener("visibilitychange", reannounce);
    announceLeave();
    channel.close();
  };
}

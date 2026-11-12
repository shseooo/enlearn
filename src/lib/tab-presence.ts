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

/**
 * 다른 탭이 살아 있는 동안 호출된다. 인자는 "다른 탭의 개수".
 * 지원되지 않는 환경(구 브라우저·SSR)에서는 아무것도 하지 않는 빈 cleanup을 돌려준다.
 */
export function watchOtherTabs(onChange: (others: number) => void): () => void {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  // 같은 탭의 자기 메시지는 무시하지만, id가 겹치면 다른 탭을 놓친다.
  // randomUUID가 없는 환경에서도 유일하도록 난수 + 증가 번호를 함께 쓴다.
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++nextId}`;
  const channel = new BroadcastChannel(TAB_CHANNEL);
  const peers = new Set<string>();

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
      peers.add(message.id);
      // 새로 들어온 탭에게 "여기 있다"는 것을 알려준다(먼저 열린 탭은 join을 기다리지 않는다).
      if (message.type === "join") post("here");
    }
    onChange(peers.size);
  };

  const announceLeave = (): void => post("leave");
  window.addEventListener("pagehide", announceLeave);
  post("join");
  onChange(peers.size);

  return () => {
    window.removeEventListener("pagehide", announceLeave);
    announceLeave();
    channel.close();
  };
}

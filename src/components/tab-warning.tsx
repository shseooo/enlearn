"use client";

import { useEffect, useState } from "react";
import { watchOtherTabs } from "@/lib/tab-presence";

/**
 * 같은 앱이 다른 탭에서도 열려 있다는 안내(D3-1).
 *
 * 저장은 통째로 읽어서 통째로 다시 쓰는 방식이라, 두 탭이 동시에 연습하면
 * 마지막에 쓴 쪽만 남는다. 저장 방식을 바꾸지 않는 대신(D3-1 결정) 사실을 먼저
 * 알려준다. StorageWarning과 같은 자리에 둔다 — 저장이 일어나는 모든 탭 위에서
 * 보여야 하기 때문이다(리뷰 1-8과 같은 이유).
 */
export default function TabWarning() {
  const [others, setOthers] = useState(0);

  useEffect(() => watchOtherTabs(setOthers), []);

  if (others === 0) return null;
  return (
    <p
      role="status"
      className="mb-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900"
    >
      ⚠️ 다른 탭에서도 열려 있습니다({others}개). 한 탭에서만 사용하세요 —
      동시에 쓰면 기록이 덮어써질 수 있습니다.
    </p>
  );
}

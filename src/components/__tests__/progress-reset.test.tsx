import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProgressReset from "../progress-reset";
import {
  loadLog,
  logPractice,
  srsCount,
} from "@/lib/practice";
import {
  cacheKorean,
  getCachedKorean,
  koreanCacheCount,
  markSeen,
  seenCount,
} from "@/lib/corpus";
import { entryKey } from "@/lib/corpus-tools";

const dailyEntry = { lane: "daily" as const, en: "The cat sat on the mat." };
const classicEntry = { lane: "classic" as const, en: "Once there was a king." };

beforeEach(() => {
  window.localStorage.clear();
  // D1-1: 모든 삭제 버튼이 window.confirm을 거친다. 아래 테스트는 "확인함"을 기본으로 한다.
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProgressReset", () => {
  it("받은 문장 기록과 번역 캐시를 레인별로 지울 수 있다", async () => {
    markSeen(entryKey(dailyEntry));
    markSeen(entryKey(classicEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });
    expect(seenCount()).toBe(2);
    expect(koreanCacheCount()).toBe(1);

    await user.click(screen.getByRole("button", { name: /한국어 번역 캐시 지우기/ }));
    expect(koreanCacheCount()).toBe(0);
    expect(seenCount()).toBe(2); // 번역 캐시만 지워진다

    await user.click(screen.getByRole("button", { name: /💬 회화 기록 지우기/ }));
    expect(seenCount("daily")).toBe(0);
    expect(seenCount("classic")).toBe(1);
  });

  it("전체 초기화는 기록과 캐시를 모두 비운다", async () => {
    markSeen(entryKey(dailyEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });

    await user.click(screen.getByRole("button", { name: /전체 초기화/ }));

    expect(seenCount()).toBe(0);
    expect(koreanCacheCount()).toBe(0);
    expect(await screen.findByRole("status")).toHaveTextContent(/지웠습니다/);
  });

  it("캐시를 지운 동화 문장은 한국어를 다시 번역하게 된다", async () => {
    const key = entryKey(classicEntry);
    cacheKorean(key, "엉터리 번역.", []);
    expect(getCachedKorean(key)?.ko).toBe("엉터리 번역.");

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });

    await user.click(screen.getByRole("button", { name: /한국어 번역 캐시 지우기/ }));

    expect(getCachedKorean(key)).toBeNull();
  });

  // 리뷰 2-13: 되돌릴 수 없는 파괴 경로 세 개(연습 기록 · 복습 큐 · 둘 다)가
  // 화면 테스트 없이 살아 있었다. 어떤 저장소를 같이 지우는지를 여기서 고정한다.
  it("연습 기록 지우기는 기록만 지우고 복습 큐·본 문장 기록은 남긴다 (리뷰 2-13)", async () => {
    logPractice({
      lane: "classic",
      en: "A sentence in the practice log.",
      ko: "연습 기록에 있는 문장.",
      answer: "an attempt",
      score: 70,
      corrections: [],
    });
    markSeen(entryKey(classicEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });
    expect(loadLog()).toHaveLength(1);
    expect(srsCount()).toBe(1);

    await user.click(screen.getByRole("button", { name: /🗑 연습 기록 지우기/ }));

    expect(loadLog()).toHaveLength(0);
    expect(srsCount()).toBe(1);
    expect(seenCount()).toBe(1);
    expect(koreanCacheCount()).toBe(1);
    expect(await screen.findByRole("status")).toHaveTextContent(/지웠습니다/);
  });

  it("복습 큐 비우기는 큐만 비우고 연습 기록은 남긴다 (리뷰 2-13)", async () => {
    logPractice({
      lane: "classic",
      en: "Another logged sentence.",
      ko: "역시 기록된 문장.",
      answer: "an attempt",
      score: 55,
      corrections: [],
    });

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });

    await user.click(screen.getByRole("button", { name: /🗑 복습 큐 비우기/ }));

    expect(srsCount()).toBe(0);
    expect(loadLog()).toHaveLength(1);
  });

  it("초기화 버튼은 여러 저장소를 바꿔도 알림을 한 번만 낸다 (리뷰 3-14)", async () => {
    markSeen(entryKey(dailyEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);
    logPractice({
      lane: "classic",
      en: "A sentence logged for batching.",
      ko: "기록된 문장.",
      answer: "an attempt",
      score: 70,
      corrections: [],
    });

    // 백업 경로는 이미 묶여 있다(2차 리뷰 3-10). 같은 화면의 초기화 버튼도 같이 묶인다.
    let progressEvents = 0;
    let practiceEvents = 0;
    const onProgress = () => {
      progressEvents += 1;
    };
    const onPractice = () => {
      practiceEvents += 1;
    };
    window.addEventListener("enlearn:progress-changed", onProgress);
    window.addEventListener("enlearn:practice-changed", onPractice);

    try {
      render(<ProgressReset />);
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "연습 기록" });

      await user.click(screen.getByRole("button", { name: /전체 초기화/ }));
      expect(seenCount()).toBe(0);
      expect(koreanCacheCount()).toBe(0);
      expect(progressEvents).toBe(1); // 두 저장소를 바꿘다

      await user.click(
        screen.getByRole("button", { name: /연습 기록 \+ 복습 큐 초기화/ }),
      );
      expect(loadLog()).toHaveLength(0);
      expect(srsCount()).toBe(0);
      expect(practiceEvents).toBe(1); // 두 저장소를 바꿘다
    } finally {
      window.removeEventListener("enlearn:progress-changed", onProgress);
      window.removeEventListener("enlearn:practice-changed", onPractice);
    }
  });

  it("기록 + 큐 초기화는 두 저장소만 비우고 seen·번역 캐시는 남긴다 (리뷰 2-13)", async () => {
    logPractice({
      lane: "classic",
      en: "Yet another logged sentence.",
      ko: "또 기록된 문장.",
      answer: "an attempt",
      score: 80,
      corrections: [],
    });
    markSeen(entryKey(dailyEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);

    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });

    await user.click(
      screen.getByRole("button", { name: /연습 기록 \+ 복습 큐 초기화/ }),
    );

    expect(loadLog()).toHaveLength(0);
    expect(srsCount()).toBe(0);
    // 화면 설명("위의 받은 문장 기록과 별개")대로, 다른 저장소는 그대로다
    expect(seenCount()).toBe(1);
    expect(koreanCacheCount()).toBe(1);
  });
});

/*
 * D1-1(R6-1): 되돌릴 수 없는 삭제 버튼 일곱 개에 확인 절차가 없었다.
 * 한 클릭으로 seen·번역 캐시·연습 기록·복습 큐가 사라지고 되돌릴 수단이 없다.
 */
describe("ProgressReset — 파괴적 삭제 확인 (D1-1)", () => {
  /** 모든 저장소를 채운다 — 취소를 눌렀을 때는 하나도 줄면 안 된다. */
  function seedEveryStore(): void {
    markSeen(entryKey(dailyEntry));
    markSeen(entryKey(classicEntry));
    cacheKorean(entryKey(classicEntry), "왕이 하나 살았습니다.", ["king"]);
    logPractice({
      lane: "classic",
      en: "A stored sentence for the confirm test.",
      ko: "확인 테스트용 문장.",
      answer: "an attempt",
      score: 60,
      corrections: [],
    });
  }

  const storeCounts = () => ({
    seenDaily: seenCount("daily"),
    seenClassic: seenCount("classic"),
    korean: koreanCacheCount(),
    log: loadLog().length,
    srs: srsCount(),
  });

  /*
   * "무엇을 지우는 버튼인지"가 화면에 다시 없는 라벨과 저장소는 이 표로만 대응된다.
   * 확인이 필요한 버튼 전체(D1-1)와, 각 버튼이 지워야 할 저장소(R7-6)를 한 곳에 둔다.
   * 네 저장소를 OR로 묶으면 핸들러의 what 인자가 뒤바뀌어 큐를 지워야 할 버튼이
   * 기록을 지워도 통과한다 — 그래서 저장소마다 기대값을 적는다.
   */
  const EFFECTS: { label: RegExp; after: ReturnType<typeof storeCounts> }[] = [
    { label: /💬 회화 기록 지우기/, after: { seenDaily: 0, seenClassic: 1, korean: 1, log: 1, srs: 1 } },
    { label: /📖 동화 기록 지우기/, after: { seenDaily: 1, seenClassic: 0, korean: 1, log: 1, srs: 1 } },
    { label: /🔄 한국어 번역 캐시 지우기/, after: { seenDaily: 1, seenClassic: 1, korean: 0, log: 1, srs: 1 } },
    // "전체 초기화"는 코퍼스 쪽(seen·번역 캐시)만 지운다 — 연습 기록·복습 큐는 그대로다.
    { label: /전체 초기화/, after: { seenDaily: 0, seenClassic: 0, korean: 0, log: 1, srs: 1 } },
    { label: /🗑 연습 기록 지우기/, after: { seenDaily: 1, seenClassic: 1, korean: 1, log: 0, srs: 1 } },
    { label: /🗑 복습 큐 비우기/, after: { seenDaily: 1, seenClassic: 1, korean: 1, log: 1, srs: 0 } },
    { label: /연습 기록 \+ 복습 큐 초기화/, after: { seenDaily: 1, seenClassic: 1, korean: 1, log: 0, srs: 0 } },
  ];

  it("확인 창을 취소하면 어떤 저장소도 건드리지 않는다", async () => {
    seedEveryStore();
    const before = storeCounts();
    expect(before.seenDaily).toBe(1);
    expect(before.seenClassic).toBe(1);
    expect(before.korean).toBe(1);
    expect(before.log).toBe(1);
    expect(before.srs).toBe(1);

    vi.mocked(window.confirm).mockReturnValue(false);

    for (const { label } of EFFECTS) {
      const view = render(<ProgressReset />);
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "연습 기록" });
      await user.click(screen.getByRole("button", { name: label }));

      expect(storeCounts(), `버튼: ${label}`).toEqual(before);
      view.unmount();
      expect(window.confirm, `버튼: ${label}`).toHaveBeenCalledTimes(1);
      vi.mocked(window.confirm).mockClear();
    }
  });

  it("확인 문구는 되돌릴 수 없고 백업부터 내보내라고 말한다", async () => {
    render(<ProgressReset />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "연습 기록" });

    await user.click(screen.getByRole("button", { name: /전체 초기화/ }));

    const [prompt] = vi.mocked(window.confirm).mock.calls;
    expect(String(prompt)).toContain("되돌릴 수 없습니다");
    expect(String(prompt)).toContain("백업");
  });

  it("확인하면 각 버튼이 자기가 맡은 저장소만 지운다", async () => {
    for (const { label, after } of EFFECTS) {
      window.localStorage.clear();
      seedEveryStore();

      const view = render(<ProgressReset />);
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "연습 기록" });
      await user.click(screen.getByRole("button", { name: label }));

      expect(storeCounts(), `버튼: ${label}`).toEqual(after);
      view.unmount();
    }
  });
});

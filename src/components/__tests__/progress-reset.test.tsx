import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
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

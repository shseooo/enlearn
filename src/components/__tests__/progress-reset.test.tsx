import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import ProgressReset from "../progress-reset";
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
    await screen.findByText(/연습 기록/);
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
    await screen.findByText(/연습 기록/);

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
    await screen.findByText(/연습 기록/);

    await user.click(screen.getByRole("button", { name: /한국어 번역 캐시 지우기/ }));

    expect(getCachedKorean(key)).toBeNull();
  });
});

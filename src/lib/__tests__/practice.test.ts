import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  addForReview,
  clearLog,
  clearSrs,
  daysBetween,
  dueCount,
  dueItems,
  getPracticeSnapshot,
  gradeReview,
  lastAnswerFor,
  loadLog,
  logPractice,
  nextReviewDate,
  practiceId,
  practiceStats,
  srsCount,
  subscribeToPractice,
  REVIEW_INTERVALS,
} from "../practice";
import { localDateString } from "../corpus";
import type { PracticeInput } from "../practice";

/** 로컬 시각으로 날짜를 만든다 (toISOString은 UTC라 하루가 어긋난다) */
const day = (offset: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(9, 0, 0, 0);
  return d;
};
const today = localDateString(day(0));

const record = (overrides: Partial<PracticeInput> = {}): PracticeInput => ({
  lane: "classic",
  en: "Alice was beginning to get very tired.",
  ko: "앨리스는 아주 지겨워지기 시작했다.",
  answer: "Alice begin to get very tired.",
  score: 72,
  corrections: [{ original: "begin", better: "began" }],
  ...overrides,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("날짜 도구", () => {
  it("addDays/daysBetween은 로컬曆 기준으로 작동한다", () => {
    const base = localDateString(day(0));
    expect(addDays(base, 1)).toBe(localDateString(day(1)));
    expect(daysBetween(base, addDays(base, 7))).toBe(7);
    expect(daysBetween(addDays(base, -3), base)).toBe(3);
  });
});

describe("연습 기록", () => {
  it("채점 결과를 기록하고, 같은 문장의 같은 날 기록은 갱신한다", () => {
    logPractice(record({}));
    logPractice(record({ score: 91 }));
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].score).toBe(91);
    expect(log[0].lane).toBe("classic");
    expect(log[0].date).toBe(today);
  });

  it("답이 없으면 기록하지 않는다", () => {
    expect(logPractice(record({ answer: "  " }))).toBeNull();
    expect(loadLog()).toHaveLength(0);
  });

  it("코퍼스 문장만 복습 큐에 들어간다", () => {
    logPractice(record({})); // classic + ko → 큐에 들어간다
    logPractice(record({ lane: "ai", en: "AI made sentence here.", ko: "AI가 만든 문장" }));
    logPractice(record({ lane: "free", ko: null }));
    logPractice(record({ lane: "daily", en: "Another sentence entirely.", ko: "다른 문장" }));
    expect(srsCount()).toBe(2);
    expect(loadLog()).toHaveLength(4);
  });

  it("상한을 넘으면 가장 오래된 기록부터 버린다", () => {
    for (let i = 0; i < 415; i++) {
      logPractice(record({ en: `Sentence number ${i} is distinct enough.`, answer: `answer ${i}` }));
    }
    const log = loadLog();
    expect(log).toHaveLength(400);
    expect(log[log.length - 1].en).toContain("414");
  });

  it("지난번 답을 다시 찾아준다", () => {
    logPractice(record({ answer: "Alice begin to get tired." }));
    const id = practiceId("classic", record().en);
    expect(lastAnswerFor(id)).toBe("Alice begin to get tired.");
    expect(lastAnswerFor("없는-id")).toBeNull();
  });
});

describe("연습 통계", () => {
  it("연속练习일을 센다 (어제까지 이어지면 오늘은 안 풀어도 유지)", () => {
    logPractice(record({ en: "One distinct sentence here.", answer: "a1", now: day(-2) }));
    logPractice(record({ en: "Two distinct sentence here.", answer: "a2", now: day(-1) }));
    let stats = practiceStats();
    expect(stats.streak).toBe(2);
    expect(stats.today).toBe(0);

    logPractice(record({ en: "Three distinct sentence here.", answer: "a3" }));
    stats = practiceStats();
    expect(stats.streak).toBe(3);
    expect(stats.today).toBe(1);
    expect(stats.week).toBe(3);
    expect(stats.distinctDays).toBe(3);
  });

  it("오래된 기록은 이번 주 집계에서 빠진다", () => {
    logPractice(record({ en: "Old sentence from long ago.", answer: "old", now: day(-30) }));
    const stats = practiceStats();
    expect(stats.total).toBe(1);
    expect(stats.week).toBe(0);
    expect(stats.streak).toBe(0);
  });

  it("자주 틀린 표현을 횟수 순으로 모아준다", () => {
    logPractice(
      record({ en: "First sentence about the garden.", answer: "a", corrections: [{ original: "goed", better: "went" }] }),
    );
    logPractice(
      record({ en: "Second sentence about the garden too.", answer: "b", corrections: [{ original: "goed", better: "went" }] }),
    );
    logPractice(
      record({ en: "Third sentence about the garden here.", answer: "c", corrections: [{ original: "childs", better: "children" }] }),
    );
    const stats = practiceStats();
    expect(stats.topMistakes[0]).toEqual({ original: "goed", better: "went", count: 2 });
    expect(stats.topMistakes[1]?.original).toBe("childs");
  });

  it("평균 점수와 레인별 개수를 계산한다", () => {
    logPractice(record({ en: "A first distinct sentence.", answer: "a", score: 60 }));
    logPractice(record({ en: "A second distinct sentence.", answer: "b", score: 90 }));
    logPractice(record({ lane: "daily", en: "A third distinct sentence.", ko: "세 번째", answer: "c", score: 75 }));
    const stats = practiceStats();
    expect(stats.avgScore).toBe(75);
    expect(stats.byLane.classic).toBe(2);
    expect(stats.byLane.daily).toBe(1);
  });
});

describe("간격반복(SRS)", () => {
  const seed = () => {
    addForReview({
      id: "classic:x1",
      lane: "classic",
      en: "The rabbit hopped away quickly.",
      ko: "토끼가 잽싸게 뛰어가 버렸다.",
    });
  };

  it("새 문장은 1일 뒤에 복습으로 나온다", () => {
    seed();
    expect(dueCount()).toBe(0);
    expect(nextReviewDate()).toBe(addDays(today, REVIEW_INTERVALS[0]));
    expect(dueItems().length).toBe(0);
  });

  it("어제 넣은 문장은 오늘 복습 대기다", () => {
    addForReview({
      id: "classic:y1",
      lane: "classic",
      en: "Yesterday we planted a small tree.",
      ko: "어제 우리는 작은 나무를 심었다.",
      now: day(-1),
    });
    expect(dueCount()).toBe(1);
    expect(dueItems()[0].id).toBe("classic:y1");
  });

  it("같은 문장을 다시 넣어도 진행 상황은 그대로다", () => {
    seed();
    addForReview({
      id: "classic:x1",
      lane: "classic",
      en: "The rabbit hopped away quickly.",
      ko: "토끼가 잽싸게 뛰어가 버렸다.",
    });
    expect(srsCount()).toBe(1);
  });

  it("알고 있어요는 단계를 올려 다음 복습을 멀리 보낸다", () => {
    seed();
    const updated = gradeReview("classic:x1", "knows");
    expect(updated?.stage).toBe(1);
    expect(updated?.due).toBe(addDays(today, REVIEW_INTERVALS[1]));
    expect(updated?.lapses).toBe(0);
  });

  it("잊었어요는 단계를 낮추고 놓친 횟수를 센다", () => {
    seed();
    gradeReview("classic:x1", "knows");
    const updated = gradeReview("classic:x1", "forgot");
    expect(updated?.stage).toBe(0);
    expect(updated?.lapses).toBe(1);
    expect(updated?.due).toBe(addDays(today, REVIEW_INTERVALS[0]));
  });

  it("아슬아슬은 단계를 유지하되 한 칸 짧은 간격으로 다시 낸다", () => {
    addForReview({ id: "classic:z1", lane: "classic", en: "A sentence to review soon.", ko: "곧 복습할 문장." });
    gradeReview("classic:z1", "knows"); // stage 1
    gradeReview("classic:z1", "knows"); // stage 2
    const updated = gradeReview("classic:z1", "shaky");
    expect(updated?.stage).toBe(2);
    expect(updated?.due).toBe(addDays(today, REVIEW_INTERVALS[1]));
  });

  it("단계는 표 범위 안에서만 움직인다", () => {
    addForReview({ id: "classic:w1", lane: "classic", en: "A very long sentence indeed.", ko: "아주 긴 문장." });
    for (let i = 0; i < 10; i++) gradeReview("classic:w1", "knows");
    const item = dueItems().find((x) => x.id === "classic:w1") ?? null;
    // 최고 단계에서는 오늘 복습으로 나오지 않는다
    expect(item).toBeNull();
    expect(srsCount()).toBe(1);
  });

  it("없는 문장을 평가하면 null을 돌려준다", () => {
    expect(gradeReview("classic:없음", "knows")).toBeNull();
  });

  it("기록을 지우면 통계와 큐가 함께 비는다", () => {
    seed();
    logPractice(record({}));
    clearLog();
    clearSrs();
    expect(loadLog()).toHaveLength(0);
    expect(srsCount()).toBe(0);
    expect(practiceStats().total).toBe(0);
  });
});

describe("화면 구독 스냅샷", () => {
  it("값이 바뀌기 전에는 같은 참조를 돌려준다 (무한 재렌더 방지)", () => {
    const a = getPracticeSnapshot();
    const b = getPracticeSnapshot();
    expect(b).toBe(a);

    logPractice(record({}));
    const c = getPracticeSnapshot();
    expect(c).not.toBe(a);
    expect(c.total).toBe(1);
    expect(c.srs).toBe(1);
  });

  it("다른 탭의 storage 변경과 자체 이벤트 둘 다 구독한다", () => {
    let called = 0;
    const cleanup = subscribeToPractice(() => {
      called += 1;
    });
    window.dispatchEvent(new StorageEvent("storage", { key: "enlearn.log.v1" }));
    expect(called).toBe(1);
    logPractice(record({})); // 같은 탭의 변경은 자체 이벤트로 알린다
    expect(called).toBe(2);
    cleanup();
    window.dispatchEvent(new StorageEvent("storage", { key: "enlearn.log.v1" }));
    expect(called).toBe(2);
  });
});

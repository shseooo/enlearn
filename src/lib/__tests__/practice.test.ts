import { beforeEach, describe, expect, it, vi } from "vitest";
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
  MAX_SRS,
  nextReviewDate,
  practiceId,
  practiceStats,
  reviewItems,
  srsCount,
  importLog,
  importSrs,
  subscribeToPractice,
  weeklySeries,
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
  it("addDays/daysBetween은 로컬 달력 기준으로 작동한다", () => {
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
  it("연속 연습일을 센다 (어제까지 이어지면 오늘은 안 풀어도 유지)", () => {
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

describe("주간 집계 (그래프)", () => {
  it("빈 칸까지 포함해 최근 n주를 월요일 시작·일요일 끝으로 돌려준다", () => {
    const weeks = weeklySeries(4);
    expect(weeks).toHaveLength(4);
    for (const w of weeks) {
      expect(w.end).toBe(addDays(w.start, 6));
      expect(w.count).toBe(0);
    }
    // 마지막 주에는 오늘이 들어 있다
    const last = weeks[weeks.length - 1];
    expect(last.start <= today && today <= last.end).toBe(true);
    // 오래된 주 → 최신 주 순서
    expect(weeks[0].start < weeks[1].start).toBe(true);
  });

  it("주 단위로 문장 수·평균 점수·교정 개수를 합친다", () => {
    const layout = weeklySeries(4);
    const prevWeek = layout[layout.length - 2];
    // 그 주 한복판(정오) 시각으로 기록한다 (로컬 달력 기준)
    const midPrev = new Date(`${prevWeek.start}T12:00:00`);

    logPractice(
      record({
        en: "Sentence practiced this week.",
        answer: "a",
        score: 70,
        corrections: [{ original: "goed", better: "went" }],
      }),
    );
    logPractice(
      record({ en: "Sentence practiced last week one.", answer: "b", score: 80, now: midPrev }),
    );
    logPractice(
      record({ en: "Another sentence last week too.", answer: "c", score: 90, now: midPrev }),
    );

    const weeks = weeklySeries(4);
    expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(3);
    const current = weeks[weeks.length - 1];
    expect(current.count).toBe(1);
    expect(current.mistakes).toBe(1);
    expect(current.avgScore).toBe(70);
    const last = weeks.find((w) => w.start === prevWeek.start);
    expect(last?.count).toBe(2);
    expect(last?.avgScore).toBe(85);
  });

  it("범위보다 오래된 기록은 집계되지 않는다", () => {
    logPractice(record({ en: "Ancient practice sentence.", answer: "a", now: day(-60) }));
    logPractice(record({ en: "Recent practice sentence here.", answer: "b" }));
    const weeks = weeklySeries(3);
    expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(1);
  });
});

describe("백업으로 복원 (기록·복습 큐)", () => {
  it("형식이 잘못된 항목은 걸러내고 나머지를 합친다", () => {
    logPractice(record({ en: "Existing sentence in the log.", answer: "a" }));
    const accepted = importLog([
      {
        date: addDays(today, -1),
        lane: "classic",
        en: "Imported sentence number one.",
        ko: "불러온 첫 문장.",
        answer: "x",
        score: 88,
        corrections: [{ original: "goed", better: "went", reason: "과거형" }],
      },
      { date: "엉망", lane: "classic", en: "No valid date here.", answer: "x" },
      { date: today, lane: "spaceship", en: "Bad lane value here.", answer: "x" },
      "문자열 항목",
      null,
    ]);
    expect(accepted).toBe(1);
    const log = loadLog();
    expect(log).toHaveLength(2);
    const imported = log.find((r) => r.en === "Imported sentence number one.");
    expect(imported?.score).toBe(88);
    expect(imported?.corrections).toEqual([{ original: "goed", better: "went" }]);
    expect(imported?.id).toBeTruthy();
  });

  it("점수는 0~100으로 좁히고, 같은 id·날짜는 새 값으로 바꾼다", () => {
    logPractice(record({ en: "A sentence to overwrite.", answer: "old", score: 40 }));
    importLog([
      {
        date: today,
        lane: "classic",
        en: "A sentence to overwrite.",
        ko: "덮어쓸 문장.",
        answer: "new",
        score: 400,
      },
    ]);
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].answer).toBe("new");
    expect(log[0].score).toBe(100);
  });

  it("replace 모드는 기존 기록을 지운다", () => {
    logPractice(record({ en: "Old record to discard.", answer: "a" }));
    const accepted = importLog(
      [{ date: today, lane: "daily", en: "Fresh record only.", ko: "새 기록.", answer: "b", score: 66 }],
      true,
    );
    expect(accepted).toBe(1);
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].en).toBe("Fresh record only.");
  });

  it("유효한 항목이 하나도 없으면 저장소를 건드리지 않는다", () => {
    const before = window.localStorage.getItem("enlearn.log.v1");
    expect(importLog([{ nope: 1 }, "x"])).toBe(0);
    expect(window.localStorage.getItem("enlearn.log.v1")).toBe(before);
  });

  it("복습 큐 병합은 이미 멀리까지 간 항목을 남긴다", () => {
    addForReview({ id: "classic:k1", lane: "classic", en: "A sentence for the merge.", ko: "병합 문장." });
    gradeReview("classic:k1", "knows"); // stage 1, due +3
    const accepted = importSrs([
      {
        id: "classic:k1",
        lane: "classic",
        en: "A sentence for the merge.",
        ko: "병합 문장.",
        stage: 0,
        due: addDays(today, 1), // 더 이른 날짜 (되돌리는 값)
        lapses: 0,
        lastReviewed: null,
      },
    ]);
    expect(accepted).toBe(1);
    const [item] = reviewItems();
    expect(item.stage).toBe(1);
    expect(item.due).toBe(addDays(today, 3));
  });

  it("복습 큐 replace는 새 큐로 바꾼다", () => {
    addForReview({ id: "classic:old1", lane: "classic", en: "A stale queue item.", ko: "옛날 큐 항목." });
    importSrs(
      [
        {
          id: "classic:new1",
          lane: "classic",
          en: "A brand new queue item.",
          ko: "새 큐 항목.",
          stage: 2,
          due: addDays(today, 7),
          lapses: 1,
          lastReviewed: today,
        },
      ],
      true,
    );
    const items = reviewItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("classic:new1");
    expect(items[0].stage).toBe(2);
  });

  it("복습 큐의 이상한 값은 안전한 값으로 고쳐 담는다", () => {
    importSrs([
      {
        id: "classic:j1",
        lane: "classic",
        en: "Junk values in this item.",
        ko: "이상한 값 항목.",
        stage: 99,
        due: "2026-13-45",
        lapses: -4,
      },
      { id: "classic:j2", lane: "classic", en: "No due date item.", ko: "마감일 없음." },
    ]);
    const items = reviewItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("classic:j1");
    expect(items[0].stage).toBe(REVIEW_INTERVALS.length - 1);
    expect(items[0].lapses).toBe(0);
  });
});

describe("저장소 상한·실패 처리 (리뷰 3-9)", () => {
  const setItem = window.localStorage.setItem.bind(window.localStorage);

  function failWrites(message = "QuotaExceededError") {
    // 프로토타입을 잡는다: 모듈은 전역 localStorage를, 테스트는 window.localStorage를
    // 참조하므로 한쪽만 스파이하면 다른 쪽이 조용히 성공한다.
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException(message, "QuotaExceededError");
    });
  }

  function restoreWrites() {
    vi.spyOn(Storage.prototype, "setItem").mockRestore();
  }

  it("저장이 실패해도 예외가 밖으로 새지 않고 이전 값이 남는다", () => {
    logPractice({
      lane: "classic",
      en: "Keep me.",
      ko: "남는 문장.",
      answer: "keep me",
      score: 70,
      corrections: [],
    });
    const before = window.localStorage.getItem("enlearn.log.v1");
    failWrites();
    expect(() =>
      logPractice({
        lane: "classic",
        en: "New sentence that cannot be stored.",
        ko: "저장되지 않는 문장.",
        answer: "nope",
        score: 10,
        corrections: [],
      }),
    ).not.toThrow();
    expect(window.localStorage.getItem("enlearn.log.v1")).toBe(before);
    restoreWrites();
    setItem("enlearn.log.v1", before!);
  });

  it("백업으로 500개를 넘겨도 400개만 저장되고 실제 개수를 알려준다", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `bulk-${i}`,
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      ts: 1_700_000_000_000 + i,
      lane: "classic",
      en: `Bulk sentence ${i}.`,
      ko: `대량 기록 ${i}번 문장.`,
      answer: "answer",
      score: 50,
      corrections: [],
    }));
    expect(importLog(items)).toBeLessThanOrEqual(400);
    expect(practiceStats().total).toBe(400);
  });

  it("대체(replace)도 상한으로 잘린 개수가 아니라 실제 저장 개수를 알려준다 (리뷰 1-4)", () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `replace-${i}`,
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      ts: 1_700_000_000_000 + i,
      lane: "classic",
      en: `Replace sentence ${i}.`,
      ko: `대체 기록 ${i}번 문장.`,
      answer: "answer",
      score: 50,
      corrections: [],
    }));
    // 기존 기록이 있어도 대체 후 개수는 상한 안에서 맞는다
    logPractice({
      lane: "classic",
      en: "A sentence stored before the replace.",
      ko: "대체 전에 저장된 문장.",
      answer: "old",
      score: 30,
      corrections: [],
    });

    expect(importLog(items, true)).toBe(400);
    expect(practiceStats().total).toBe(400);
    expect(loadLog().some((r) => r.id === "replace-499")).toBe(true);
    expect(loadLog().some((r) => r.id === "replace-0")).toBe(false);
  });

  it("대체할 항목이 0개면 저장소도 비워진다", () => {
    logPractice({
      lane: "classic",
      en: "A sentence to be wiped by an empty replace.",
      ko: "빈 대체로 지워지는 문장.",
      answer: "bye",
      score: 40,
      corrections: [],
    });
    expect(practiceStats().total).toBe(1);
    expect(importLog([], true)).toBe(0);
    expect(practiceStats().total).toBe(0);
  });

  it("복습 큐는 상한을 넘지 않고, 진척도가 낮은 항목부터 밀려난다", () => {
    const many = Array.from({ length: 600 }, (_, i) => ({
      id: `queue-${i}`,
      lane: "classic",
      en: `Queued sentence ${i}.`,
      ko: `복습 큐 ${i}번 문장.`,
      stage: i < 500 ? 3 : 0,
      due: "2026-06-01",
      lapses: 0,
      lastReviewed: null,
    }));
    const stored = importSrs(many);
    expect(stored).toBeLessThanOrEqual(MAX_SRS);
    const items = reviewItems();
    expect(items.length).toBe(MAX_SRS);
    expect(items.every((x) => x.stage === 3)).toBe(true);
    // 새로 넣으려 해도 상한을 넘기지 않는다
    addForReview({ id: "one-more", lane: "classic", en: "One more.", ko: "한 개 추가.", now: new Date() });
    expect(reviewItems().length).toBe(MAX_SRS);
  });

  it("저장이 실패한 항목은 개수에 포함되지 않는다", () => {
    const before = practiceStats().total;
    failWrites();
    expect(
      importLog([
        {
          id: "unstored",
          date: "2026-02-01",
          ts: 1,
          lane: "classic",
          en: "Cannot store.",
          ko: "저장 불가.",
          answer: "x",
          score: 1,
          corrections: [],
        },
      ]),
    ).toBe(0);
    expect(practiceStats().total).toBe(before);
    restoreWrites();
  });
});

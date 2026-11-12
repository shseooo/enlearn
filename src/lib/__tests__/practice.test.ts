import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  addForReview,
  clearLog,
  clearSrs,
  dueCount,
  dueItems,
  getPracticeSnapshot,
  gradeReview,
  lastAnswerFor,
  loadLog,
  logPractice,
  MAX_RECORDS,
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

/*
 * "오늘"을 고정한다(R6-23). 아래 day()/today는 모듈이 불러올 때의 실제 시계로
 * 계산되는데, 테스트 대상(logPractice·dueItems)은 호출 시점의 시계를 쓴다.
 * 테스트 실행이 로컬 자정을 넘으면 "log[0].date === today" 같은 단언이 깨진다.
 * Date만 가짜로 바꿔, setTimeout(자정 알림) 등 다른 타이머는 그대로 둔다.
 */
const FIXED_NOW = new Date(2026, 10, 11, 9, 0, 0);
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(FIXED_NOW);

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
  // 자정 테스트처럼 vi.useRealTimers()로 되돌리는 테스트가 뒤따라 있어도 "오늘"이
  // 어긋나지 않게 매 테스트 앞에 시계를 다시 고정한다(R6-23).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("날짜 도구", () => {
  // daysBetween은 production에서 쓰지 않는 export라 지웠다(리뷰 4-8).
  // 같은 날짜 규칙은 addDays 왕복으로 확인한다.
  it("addDays는 로컬 달력 기준으로 전후 모두 작동한다", () => {
    const base = localDateString(day(0));
    expect(addDays(base, 1)).toBe(localDateString(day(1)));
    expect(addDays(base, 7)).toBe(localDateString(day(7)));
    expect(addDays(base, -3)).toBe(localDateString(day(-3)));
    // 7일 뒤에서 7일 전으로 돌아오면 같은 날짜다 (일수 계산의 근거)
    expect(addDays(addDays(base, 7), -7)).toBe(base);
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
    for (let i = 0; i < MAX_RECORDS + 15; i++) {
      logPractice(record({ en: `Sentence number ${i} is distinct enough.`, answer: `answer ${i}` }));
    }
    const log = loadLog();
    expect(log).toHaveLength(MAX_RECORDS);
    expect(log[log.length - 1].en).toContain(String(MAX_RECORDS + 14));
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

  // 리뷰 2-9: 자정에는 저장은 그대로인데 "오늘 대기"만 바뀐다. 원문 비교만으로는
  // 스냅샷이 새 참조를 만들지 않아, 자정 타이머가 없는 ⚙️ 설정 화면이 어제의 0개를 계속 보여줬다.
  it("자정을 넘기면 저장소 변경 없이도 스냅샷이 다시 계산된다 (리뷰 2-9)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 5, 23, 30, 0));
      logPractice(
        record({
          en: "A sentence that becomes due after midnight.",
          ko: "자정 뒤에 복습 나오는 문장.",
          answer: "an attempt",
          now: new Date(2026, 0, 5, 9, 0, 0),
        }),
      );

      let notified = 0;
      const cleanup = subscribeToPractice(() => {
        notified += 1;
      });
      const before = getPracticeSnapshot();
      expect(before.due).toBe(0);

      vi.advanceTimersByTime(45 * 60 * 1000); // 로컬 자정을 넘어 1/6 00:15
      expect(notified).toBe(1);

      const after = getPracticeSnapshot();
      expect(after).not.toBe(before);
      expect(after.due).toBe(1);
      // 지난 참조는 그대로 두고 새 참조로 변화를 알린다 (useSyncExternalStore 규칙)
      expect(before.due).toBe(0);
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  // 리뷰 3-8: 자정 예약이 자기 자신을 무한히 다시 예약해서, 구독이 0명이 되어도 살아 있었다.
  it("마지막 구독을 해제하면 자정 타이머도 함께 끊긴다", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 0, 5, 23, 30, 0));

      let notified = 0;
      const first = subscribeToPractice(() => {
        notified += 1;
      });
      const second = subscribeToPractice(() => {});
      const armed = vi.getTimerCount();
      expect(armed).toBeGreaterThan(0);

      first();
      // 구독이 하나 남아 있으면 자정 예약도 그대로다
      expect(vi.getTimerCount()).toBe(armed);

      second();
      // 마지막 구독이 풀리면 예약이 취소된다
      expect(vi.getTimerCount()).toBe(armed - 1);

      vi.advanceTimersByTime(60 * 60 * 1000); // 자정을 지나 1/6 00:30
      expect(notified).toBe(0);

      // 다시 구독하면 그 자리에서 자정 예약이 되살아난다
      const third = subscribeToPractice(() => {
        notified += 1;
      });
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000); // 다음 자정 1/7 00:00
      expect(notified).toBe(1);
      third();
    } finally {
      vi.useRealTimers();
    }
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
    expect(accepted.stored).toBe(1);
    // 형식이 맞지 않는 4건(날짜·레인·문자열·null)은 세어 돌아온다(D4-2).
    expect(accepted.rejected).toBe(4);
    const log = loadLog();
    expect(log).toHaveLength(2);
    const imported = log.find((r) => r.en === "Imported sentence number one.");
    expect(imported?.score).toBe(88);
    expect(imported?.corrections).toEqual([{ original: "goed", better: "went" }]);
    expect(imported?.id).toBeTruthy();
  });

  it("점수는 0~100으로 좁히고, 같은 id·날짜는 더 최근 시각의 새 값으로 바꾼다", () => {
    logPractice(record({ en: "A sentence to overwrite.", answer: "old", score: 40 }));
    const [existing] = loadLog();
    // D2-1(R6-2): 같은 id·날짜는 "시각이 더 최근인 값"이 이긴다. 백업이 실제로
    // 더 뒤에 만들어진 경우를 써야 대체가 일어난다.
    importLog([
      {
        date: today,
        ts: existing.ts + 60_000,
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

  // D2-1(R6-2): "누가 이기나"가 저장소마다 달랐다. 지금은 네 저장소 모두 최신 우선이다.
  it("합치기는 더 오래된 백업으로 최근 기록을 덮어쓰지 않는다 (D2-1)", () => {
    logPractice(record({ en: "Newest answer stays here.", answer: "newest", score: 90 }));
    const [existing] = loadLog();
    const result = importLog([
      { ...existing, answer: "older", score: 10, ts: existing.ts - 60_000 },
    ]);
    expect(result.stored).toBe(1);
    expect(loadLog()).toHaveLength(1);
    expect(loadLog()[0].answer).toBe("newest");
    expect(loadLog()[0].score).toBe(90);
  });

  it("합치기는 더 최근 ts로 갈아타고, 같은 시각이면 기존 값을 남긴다 (D2-1)", () => {
    logPractice(record({ en: "Older answer sits here.", answer: "older", score: 20 }));
    const [existing] = loadLog();
    importLog([
      { ...existing, answer: "newer", score: 95, ts: existing.ts + 60_000 },
    ]);
    expect(loadLog()[0].answer).toBe("newer");
    // 시각이 같으면 기존 값(이미 화면에서 본 값)이 이긴다.
    importLog([{ ...loadLog()[0], answer: "same-instant", ts: loadLog()[0].ts }]);
    expect(loadLog()[0].answer).toBe("newer");
  });

  it("복습 큐 합치기도 마지막 복습 시각이 더 최근인 값을 남긴다 (D2-1)", () => {
    addForReview({
      id: "classic:winner",
      lane: "classic",
      en: "Review merge winner.",
      ko: "복습 병합 승자.",
    });
    gradeReview("classic:winner", "knows"); // lastReviewed = 오늘
    const [stored] = reviewItems();
    expect(stored.lastReviewed).toBe(today);

    // 더 옛날에 복습한(= 더 오래된) 사본이 들어와도 진행을 되돌리지 않는다.
    const older = importSrs([
      {
        id: "classic:winner",
        lane: "classic",
        en: "Review merge winner.",
        ko: "복습 병합 승자.",
        stage: 0,
        due: addDays(today, 1),
        lapses: 9,
        lastReviewed: addDays(today, -30),
      },
    ]);
    expect(older.stored).toBe(1);
    expect(reviewItems()[0].stage).toBe(stored.stage);
    expect(reviewItems()[0].lapses).toBe(0);

    // 실제 복습이 적힌 더 최근 사본은 받아들여진다.
    importSrs([
      {
        id: "classic:winner",
        lane: "classic",
        en: "Review merge winner.",
        ko: "복습 병합 승자.",
        stage: 3,
        due: addDays(today, 21),
        lapses: 0,
        lastReviewed: addDays(today, 1),
      },
    ]);
    expect(reviewItems()[0].stage).toBe(3);

    // lastReviewed가 null(미복습)은 가장 오래된 값으로 본다 — 같은 기준의 빈자리 규정.
    addForReview({
      id: "classic:null-review",
      lane: "classic",
      en: "Review merge null case.",
      ko: "복습 병합 null.",
    });
    importSrs([
      {
        id: "classic:null-review",
        lane: "classic",
        en: "Review merge null case.",
        ko: "복습 병합 null.",
        stage: 2,
        due: addDays(today, 7),
        lapses: 0,
        lastReviewed: today,
      },
    ]);
    expect(reviewItems().find((x) => x.id === "classic:null-review")?.stage).toBe(2);
  });

  // R5-4(R6-17): en/ko/answer는 clip으로 자르는데 id만 무제한이었다.
  it("지나치게 긴 id는 잘리지 않고 문장 기준으로 다시 만든다 (R5-4)", () => {
    const hugeId = "x".repeat(5_000);
    importLog(
      [
        {
          id: hugeId,
          date: today,
          lane: "classic",
          en: "A record with a runaway id.",
          ko: "id가 긴 기록.",
          answer: "a",
          score: 50,
        },
      ],
      true,
    );
    const [recordWithShortId] = loadLog();
    expect(recordWithShortId.id.length).toBeLessThanOrEqual(200);
    // id는 화면에 보이는 문장(en) 기준으로 다시 만든다 — lastAnswerFor가 계속 찾는다.
    expect(recordWithShortId.id).toBe(practiceId("classic", "A record with a runaway id."));

    importSrs(
      [
        {
          id: hugeId,
          lane: "classic",
          en: "A queue item with a runaway id.",
          ko: "id가 긴 큐 항목.",
          stage: 1,
          due: addDays(today, 3),
          lapses: 0,
          lastReviewed: null,
        },
      ],
      true,
    );
    const [queueItem] = reviewItems();
    expect(queueItem.id.length).toBeLessThanOrEqual(200);
    expect(queueItem.id).toBe(practiceId("classic", "A queue item with a runaway id."));
  });

  it("replace 모드는 기존 기록을 지운다", () => {    logPractice(record({ en: "Old record to discard.", answer: "a" }));
    const accepted = importLog(
      [{ date: today, lane: "daily", en: "Fresh record only.", ko: "새 기록.", answer: "b", score: 66 }],
      true,
    );
    expect(accepted.stored).toBe(1);
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].en).toBe("Fresh record only.");
  });

  it("유효한 항목이 하나도 없으면 저장소를 건드리지 않는다", () => {
    const before = window.localStorage.getItem("enlearn.log.v1");
    expect(importLog([{ nope: 1 }, "x"]).stored).toBe(0);
    expect(window.localStorage.getItem("enlearn.log.v1")).toBe(before);
  });

  // 리뷰 3-7: 백업 경로는 20개, 읽기는 5개였다. logPractice 한 번이 잘린 개수로
  // 저장소를 다시 쓰면 백업에 있던 교정이 회복 불가능하게 사라진다.
  it("저장한 교정 개수와 읽히는 교정 개수가 같다 (리뷰 3-7)", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      original: `goed${i}`,
      better: `went${i}`,
    }));
    importLog(
      [
        {
          date: today,
          lane: "classic",
          en: "A sentence restored with many corrections.",
          ko: "교정이 많은 문장.",
          answer: "a",
          score: 70,
          corrections: many,
        },
      ],
      true,
    );

    const storedRaw = () =>
      JSON.parse(window.localStorage.getItem("enlearn.log.v1") ?? "[]") as {
        corrections: unknown[];
      }[];
    expect(loadLog()[0].corrections).toHaveLength(5);
    expect(storedRaw()[0].corrections).toHaveLength(5);

    // 다른 문장을 기록하면 배열 전체를 다시 쓴다 — 읽히지 않는 교정은 남아 있지 않다
    logPractice(record({ en: "Another logged sentence entirely.", answer: "b" }));
    expect(storedRaw()[0].corrections).toHaveLength(5);
    expect(loadLog()[0].corrections).toHaveLength(5);
  });

  // 리뷰 4-4: 날짜에 상한이 없으면 백업의 미래 날짜가 MAX_RECORDS 트림에서
  // 항상 이겨 실제 학습 기록이 조용히 잘려 나간다.
  it("미래 날짜로 채운 백업은 실제 기록을 밀어내지 않는다 (리뷰 4-4)", () => {
    logPractice(record({ en: "Real practice one here.", answer: "a", now: day(-2) }));
    logPractice(record({ en: "Real practice two here.", answer: "b", now: day(-1) }));
    logPractice(record({ en: "Real practice three here.", answer: "c" }));
    const before = loadLog().map((r) => r.en);

    // MAX_RECORDS와 같은 개수로 채운다 (상한 트림이 실제 기록을 이기지 못한다)
    const flooded = Array.from({ length: MAX_RECORDS }, (_, i) => ({
      id: `future-${i}`,
      date: "2099-01-01",
      ts: Date.parse("2099-01-01T00:00:00Z"),
      lane: "classic",
      en: `Flooded future record ${i}.`,
      answer: "x",
      score: 10,
    }));
    // 거부된 개수는 stored 0 · rejected MAX_RECORDS로 돌아온다 — 성공처럼 보이면 안 된다
    const floodedResult = importLog(flooded);
    expect(floodedResult.stored).toBe(0);
    expect(floodedResult.rejected).toBe(MAX_RECORDS);
    expect(loadLog().map((r) => r.en)).toEqual(before);
  });

  it("하루 어긋난 시계는 살고(오늘로 정규화), 그 이상·2000년 이전은 거부한다 (리뷰 4-4)", () => {
    const accepted = importLog([
      { id: "skew-1", date: addDays(today, 1), lane: "daily", en: "Clock one day ahead.", answer: "a" },
      { id: "skew-2", date: addDays(today, 2), lane: "daily", en: "Clock two days ahead.", answer: "b" },
      { id: "ancient", date: "0001-01-01", lane: "daily", en: "Impossible old date here.", answer: "c" },
    ]);
    expect(accepted.stored).toBe(1);
    expect(accepted.rejected).toBe(2);
    const [one] = loadLog();
    expect(one.en).toBe("Clock one day ahead.");
    // 저장소에 미래 날짜를 남기지 않는다 — 상한 트림의 정렬 키가 깨지지 않는다
    expect(one.date).toBe(today);
    expect(loadLog()).toHaveLength(1);
  });

  it("이미 저장된 미래 날짜는 읽을 때 바로잡는다 (리뷰 4-4)", () => {
    // 손으로 고치거나 옛 버전이 남긴 저장소: 값 자체는 버리지 않고 오늘로 끌어내린다.
    window.localStorage.setItem(
      "enlearn.log.v1",
      JSON.stringify([
        {
          id: "broken-clock",
          date: "9999-12-31",
          ts: Date.parse("9999-12-31T00:00:00Z"),
          lane: "classic",
          en: "Stored with a broken clock.",
          ko: null,
          answer: "a",
          score: 50,
          corrections: [],
        },
      ]),
    );
    const [r] = loadLog();
    expect(r.date).toBe(today);
    expect(r.ts).toBeLessThanOrEqual(Date.now());
    // 상한 트림이 실제 기록을 밀어내는 근거(정렬 키)만 고르고 내용은 그대로다
    expect(r.en).toBe("Stored with a broken clock.");
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
    expect(accepted.stored).toBe(1);
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

  it("백업이 상한을 넘기면 최근 기록이 남고 잘린 개수를 알려준다", () => {
    const items = Array.from({ length: MAX_RECORDS + 100 }, (_, i) => ({
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
    const result = importLog(items);
    expect(result.stored).toBe(MAX_RECORDS);
    // 상한으로 잘린 개수가 별도로 드러난다(D4-2/R6-3).
    expect(result.trimmed).toBe(100);
    expect(result.rejected).toBe(0);
    expect(practiceStats().total).toBe(MAX_RECORDS);
  });

  it("대체(replace)도 상한으로 잘린 개수가 아니라 실제 저장 개수를 알려준다 (리뷰 1-4)", () => {
    const items = Array.from({ length: MAX_RECORDS + 100 }, (_, i) => ({
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

    const result = importLog(items, true);
    expect(result.stored).toBe(MAX_RECORDS);
    expect(result.trimmed).toBe(100);
    expect(practiceStats().total).toBe(MAX_RECORDS);
    expect(loadLog().some((r) => r.id === `replace-${MAX_RECORDS + 99}`)).toBe(true);
    expect(loadLog().some((r) => r.id === "replace-0")).toBe(false);
  });

  // R6-7: 대체 경로는 파일에 적힌 순서로 잘랐다. 내림차순 백업에서는 가장 최근
  // 기록이 먼저 버려지고 가장 오래된 기록이 남았다 — 병합 경로와 정반대다.
  it("대체(replace)는 파일 순서가 아니라 날짜 기준으로 잘린다 (R6-7)", () => {
    const total = MAX_RECORDS + 100;
    // 백업의 첫 줄이 가장 최근인(날짜 내림차순) 파일처럼 만든다.
    const descending = Array.from({ length: total }, (_, i) => ({
      id: `desc-${total - 1 - i}`,
      date: addDays(today, -i),
      ts: 1_700_000_000_000 + (total - 1 - i),
      lane: "classic",
      en: `Descending record ${i}.`,
      answer: "x",
      score: 50,
    }));
    const result = importLog(descending, true);
    expect(result.stored).toBe(MAX_RECORDS);
    expect(result.trimmed).toBe(100);
    const log = loadLog();
    // 살아남는 것은 가장 최근 날짜의 기록이고, 가장 오래된 100건이 버려진다.
    expect(log.some((r) => r.id === `desc-${total - 1}`)).toBe(true);
    expect(log.some((r) => r.id === "desc-0")).toBe(false);
    const keptDates = log.map((r) => r.date);
    const droppedIds = new Set(log.map((r) => r.id));
    const droppedDates = descending
      .filter((item) => !droppedIds.has(item.id))
      .map((item) => item.date);
    const oldestKept = keptDates.reduce((min, d) => (d < min ? d : min), keptDates[0]);
    const newestDropped = droppedDates.reduce((max, d) => (d > max ? d : max), droppedDates[0]);
    // 잘린 것은 최신 쪽이 아니라 옛날 쪽이어야 한다.
    expect(newestDropped < oldestKept).toBe(true);
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
    expect(importLog([], true).stored).toBe(0);
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
    const stored = importSrs(many).stored;
    expect(stored).toBeLessThanOrEqual(MAX_SRS);
    const items = reviewItems();
    expect(items.length).toBe(MAX_SRS);
    expect(items.every((x) => x.stage === 3)).toBe(true);
    // 새로 넣으려 해도 상한을 넘기지 않는다
    addForReview({ id: "one-more", lane: "classic", en: "One more.", ko: "한 개 추가.", now: new Date() });
    expect(reviewItems().length).toBe(MAX_SRS);
  });

  // 리뷰 4-9: 개수만 보는 상한 테스트로는 "누가 살아남는가"가 고정되지 않는다.
  it("복습 큐 상한은 같은 진척도 안에서 이른 복습 날짜를 남긴다 (리뷰 4-9)", () => {
    // stage가 모두 같으면 due가 빠른 쪽이 살아남는다 — 미래 날짜가 앞줄을 차지하지 않는다.
    const many = Array.from({ length: MAX_SRS + 40 }, (_, i) => ({
      id: `tie-${i}`,
      lane: "classic",
      en: `Tied sentence ${i}.`,
      ko: `진행이 같은 문장 ${i}번.`,
      stage: 2,
      due: i < MAX_SRS ? "2026-02-01" : "2099-01-01",
      lapses: 0,
      lastReviewed: null,
    }));
    importSrs(many, true);

    const items = reviewItems();
    expect(items.length).toBe(MAX_SRS);
    expect(items.every((x) => x.due === "2026-02-01")).toBe(true);
    expect(items.some((x) => x.due === "2099-01-01")).toBe(false);
  });

  // 리뷰 4-9: 입력 가드(addForReview)와 형식 밖 항목 걸러내기가 테스트로 고정되지 않았다.
  it("addForReview는 빈 id·en·ko를 조용히 거부한다 (리뷰 4-9)", () => {
    addForReview({ id: "", lane: "classic", en: "No id sentence here.", ko: "id가 없는 항목." });
    addForReview({ id: "classic:empty-en", lane: "classic", en: "   ", ko: "빈 영어 항목." });
    addForReview({ id: "classic:empty-ko", lane: "classic", en: "No ko sentence here.", ko: "  " });
    expect(srsCount()).toBe(0);

    addForReview({ id: "classic:ok", lane: "classic", en: "Valid queue item.", ko: "정상 항목." });
    expect(srsCount()).toBe(1);
  });

  it("형식 밖의 복습 큐·교정 항목은 걸러지고 나머지는 남는다 (리뷰 4-9)", () => {
    const acceptedSrs = importSrs([
      null,
      "문자열 항목",
      // due는 모두 유효하게 두어, 각 항목이 "의도한 가드"로만 걸러지는지 확인한다.
      { id: 42, lane: "classic", due: "2026-06-01", en: "Numeric id here.", ko: "숫자 id 항목." },
      { id: "classic:lane", lane: "spaceship", due: "2026-06-01", en: "Bad lane here.", ko: "모르는 레인 항목." },
      { id: "classic:noko", lane: "classic", due: "2026-06-01", en: "Missing ko here.", ko: "" },
      { id: "classic:nodue", lane: "classic", en: "Missing due here.", ko: "due 없는 항목." },
      { id: "classic:ok", lane: "classic", due: "2026-06-01", en: "Surviving queue item.", ko: "남는 큐 항목." },
    ]);
    expect(acceptedSrs.stored).toBe(1);
    expect(acceptedSrs.rejected).toBe(6);
    expect(reviewItems().map((x) => x.id)).toEqual(["classic:ok"]);

    const acceptedLog = importLog([
      { id: "no-en", date: today, lane: "classic", en: "", answer: "a", score: 10 },
      {
        id: "junk-corrections",
        date: today,
        lane: "classic",
        en: "Corrections with junk entries.",
        answer: "a",
        score: 50,
        corrections: ["문자열 교정", { original: 1, better: "x" }, { original: "goed", better: "went" }],
      },
    ]);
    expect(acceptedLog.stored).toBe(1);
    expect(acceptedLog.rejected).toBe(1);
    expect(loadLog()[0].corrections).toEqual([{ original: "goed", better: "went" }]);
  });

  it("저장소에 형식 밖의 복습 큐 항목이 섞여 있어도 읽기가 살아남는다 (리뷰 4-9)", () => {
    // loadSrs의 normalizeSrs 가드는 저장소를 직접 만졌을 때의 마지막 안전장치다.
    window.localStorage.setItem(
      "enlearn.srs.v1",
      JSON.stringify([
        null,
        { id: 42, lane: "classic", en: "Numeric id here.", ko: "숫자 id 항목." },
        { id: "classic:noko", lane: "classic", en: "Missing ko here.", ko: "" },
        { id: "classic:ok", lane: "classic", en: "Readable queue item.", ko: "읽히는 큐 항목." },
      ]),
    );
    expect(reviewItems().map((x) => x.id)).toEqual(["classic:ok"]);
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
      ]).stored,
    ).toBe(0);
    expect(practiceStats().total).toBe(before);
    restoreWrites();
  });
});

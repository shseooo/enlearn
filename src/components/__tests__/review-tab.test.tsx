import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReviewTab from "../review-tab";

const evaluateMock = vi.fn();

vi.mock("@/lib/llm", () => ({
  evaluateTranslation: (...args: unknown[]) => evaluateMock(...args),
}));

const SETTINGS = {
  host: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test",
};

function renderTab() {
  render(
    <ReviewTab settings={SETTINGS} onGoSettings={() => {}} />,
  );
}
import {
  addDays,
  dueItems,
  logPractice,
  practiceId,
  reviewItems,
} from "@/lib/practice";
import { localDateString } from "@/lib/corpus";

/*
 * R6-23(리뷰 5): 아래 day()는 모듈이 불러올 때의 실제 시계로 "오늘"을 계산하고,
 * ReviewTab은 호출 시점의 시계를 쓴다. 테스트가 로컬 자정을 넘기면(야간 CI 포함)
 * "어제 연습 → 오늘 복습" 같은 단언이 어긋난다. Date만 가짜로 고정한다.
 */
const FIXED_NOW = new Date(2026, 10, 11, 9, 0, 0);
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(FIXED_NOW);

const day = (offset: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  d.setHours(9, 0, 0, 0);
  return d;
};

/** 어제로 거슬러 연습하면 오늘 복습 큐에 들어온다 */
function practiceYesterday(overrides: { en: string; ko: string; answer: string }) {
  logPractice({
    lane: "classic",
    en: overrides.en,
    ko: overrides.ko,
    answer: overrides.answer,
    score: 68,
    corrections: [{ original: "goed", better: "went" }],
    now: day(-1),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  // 자정 테스트가 vi.useRealTimers()로 되돌린 뒤에도 "오늘"이 고정되도록 다시 걸는다.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("ReviewTab", () => {
  it("복습 대기 문장이 없으면 안내를 보여준다", () => {
    renderTab();
    expect(screen.getByText("복습할 문장이 아직 없습니다")).toBeInTheDocument();
    expect(
      screen.getByText(/📝 번역 연습에서 문장을 풀면 하루 뒤에/),
    ).toBeInTheDocument();
  });

  it("어제 푼 문장을 다시 내고, 정답 보기로 원문을 보여준다", async () => {
    practiceYesterday({
      en: "Alice was beginning to get very tired.",
      ko: "앨리스는 아주 지겨워지기 시작했습니다.",
      answer: "Alice begin to get very tired.",
    });
    renderTab();
    const user = userEvent.setup();

    expect(
      await screen.findByText("앨리스는 아주 지겨워지기 시작했습니다."),
    ).toBeInTheDocument();
    expect(screen.getByText(/동화 명문장 · 복습 단계 1/)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/기억나는 대로 영어로 써보세요/),
      "Alice was starting to feel very tired.",
    );
    await user.click(screen.getByRole("button", { name: /정답 보기/ }));

    expect(
      await screen.findByText("Alice was beginning to get very tired."),
    ).toBeInTheDocument();
    // 지난번 답도 함께 보여준다
    expect(screen.getByText(/지난번 답/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /알고 있어요|아슬아슬|잊었어요/ })).toHaveLength(3);
  });

  it("평점하면 다음 복습 날짜를 알려주고 큐가 비면 안내로 바뀐다", async () => {
    practiceYesterday({
      en: "The rabbit hopped away quickly.",
      ko: "토끼가 잽싸게 뛰어가 버렸습니다.",
      answer: "The rabbit hop away quick.",
    });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("토끼가 잽싸게 뛰어가 버렸습니다.");
    await user.click(screen.getByRole("button", { name: /정답 보기/ }));
    await user.click(screen.getByRole("button", { name: /알고 있어요/ }));

    const nextDue = addDays(localDateString(day(0)), 3);
    expect(
      await screen.findByText(`단계 2 · 다음 복습: ${nextDue} (약 3일 뒤)`),
    ).toBeInTheDocument();
    expect(dueItems()).toHaveLength(0);
    expect(
      await screen.findByText("오늘 복습할 문장은 없습니다"),
    ).toBeInTheDocument();
  });

  it("잊었어요는 놓친 횟수를 세고 다음 문장으로 넘어간다", async () => {
    practiceYesterday({
      en: "First sentence to review here.",
      ko: "복습할 첫 문장입니다.",
      answer: "First sentence review here.",
    });
    practiceYesterday({
      en: "Second sentence to review today.",
      ko: "복습할 두 번째 문장입니다.",
      answer: "Second sentence review today.",
    });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("복습할 첫 문장입니다.");
    await user.click(screen.getByRole("button", { name: /정답 보기/ }));
    await user.click(screen.getByRole("button", { name: /잊었어요/ }));

    expect(await screen.findByText("복습할 두 번째 문장입니다.")).toBeInTheDocument();
    // 평점한 첫 문장은 대기에서 빠지고 놓친 횟수가 남는다
    const graded = reviewItems().find((x) => x.ko === "복습할 첫 문장입니다.");
    expect(graded?.lapses).toBe(1);
    expect(graded?.stage).toBe(0);
    expect(dueItems().map((x) => x.ko)).not.toContain("복습할 첫 문장입니다.");
    expect(
      screen.queryByText("앨리스는 아주 지겨워지기 시작했습니다."),
    ).not.toBeInTheDocument();
  });

  it("다른 문장 버튼은 평가하지 않고 다음 후보로 바꾼다", async () => {
    practiceYesterday({
      en: "Alpha sentence for the rotate test.",
      ko: "돌리기 테스트의 첫 문장.",
      answer: "alpha answer",
    });
    practiceYesterday({
      en: "Beta sentence for the rotate test too.",
      ko: "돌리기 테스트의 두 번째 문장.",
      answer: "beta answer",
    });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("돌리기 테스트의 첫 문장.");
    await user.click(screen.getByRole("button", { name: /다른 문장/ }));
    expect(
      await screen.findByText("돌리기 테스트의 두 번째 문장."),
    ).toBeInTheDocument();
    expect(dueItems()).toHaveLength(2); // 평점하지 않았으므로 둘 다 대기 중
  });

  // 리뷰 2-8: 문장을 바꾸거나 평점하면 current만 바뀐 채 in-flight 채점은 그대로였다.
  // 사용자는 대기하지도 취소하지도 못한 채 토큰만 나가고 응답은 조용히 버려진다.
  it("다른 문장으로 넘어가면 진행 중이던 채점이 취소된다 (리뷰 2-8)", async () => {
    const signals: AbortSignal[] = [];
    evaluateMock.mockImplementation(
      (
        _s: unknown,
        _ko: string,
        _a: string,
        _r: unknown,
        opts?: { signal?: AbortSignal },
      ) => {
        const signal = opts?.signal as AbortSignal;
        signals.push(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("abort")));
        });
      },
    );
    practiceYesterday({ en: "Alpha grading sentence.", ko: "채점 중 첫 문장.", answer: "a" });
    practiceYesterday({ en: "Beta grading sentence.", ko: "채점 중 두 번째 문장.", answer: "b" });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("채점 중 첫 문장.");
    await user.type(screen.getByLabelText(/기억나는 대로/), "an attempt");
    await user.click(screen.getByRole("button", { name: /LLM 채점/ }));
    await screen.findByText("채점 중…");

    await user.click(screen.getByRole("button", { name: /다른 문장/ }));

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(await screen.findByText("채점 중 두 번째 문장.")).toBeInTheDocument();
    expect(screen.queryByText("채점 중…")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("평점하면 진행 중이던 채점을 끊는다 (리뷰 2-8)", async () => {
    const signals: AbortSignal[] = [];
    evaluateMock.mockImplementation(
      (
        _s: unknown,
        _ko: string,
        _a: string,
        _r: unknown,
        opts?: { signal?: AbortSignal },
      ) => {
        const signal = opts?.signal as AbortSignal;
        signals.push(signal);
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("abort")));
        });
      },
    );
    practiceYesterday({ en: "Graded sentence one.", ko: "평점 중 첫 문장.", answer: "a" });
    practiceYesterday({ en: "Graded sentence two.", ko: "평점 중 두 번째 문장.", answer: "b" });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("평점 중 첫 문장.");
    await user.type(screen.getByLabelText(/기억나는 대로/), "an attempt");
    await user.click(screen.getByRole("button", { name: /LLM 채점/ }));
    await screen.findByText("채점 중…");

    // 평점 단추는 정답을 보여준 뒤에 나타난다
    await user.click(screen.getByRole("button", { name: /정답 보기/ }));
    await user.click(screen.getByRole("button", { name: /알고 있어요/ }));

    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(screen.queryByText("채점 중…")).not.toBeInTheDocument();
  });


  it("다른 문장 버튼은 큐를 순환한다 — 세 번째 문장도 보인다 (리뷰 3-5)", async () => {
    for (const ko of ["첫 번째 순환 문장.", "두 번째 순환 문장.", "세 번째 순환 문장."]) {
      practiceYesterday({
        en: `${ko} sentence for rotation.`,
        ko,
        answer: "answer",
      });
    }
    renderTab();
    const user = userEvent.setup();

    const shown: string[] = [];
    shown.push((await screen.findByText(/순환 문장\.$/)).textContent ?? "");
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole("button", { name: /다른 문장/ }));
      const at = dueItems().find((x) => x.ko === shown[shown.length - 1]);
      // 같은 문장이 두 번 연속 나오면 안 된다
      shown.push(
        ((await screen.findByText(/순환 문장\.$/)) as HTMLElement).textContent ?? "",
      );
      void at;
    }
    expect(new Set(shown).size).toBe(3);
    expect(shown[0]).not.toBe(shown[1]);
    expect(shown[1]).not.toBe(shown[2]);
  });

  it("대기가 하나면 다른 문장을 눌러도 같은 문장이 유지된다", async () => {
    practiceYesterday({
      en: "Only sentence in the queue.",
      ko: "큐에 하나뿐인 문장.",
      answer: "answer",
    });
    renderTab();
    const user = userEvent.setup();
    await screen.findByText("큐에 하나뿐인 문장.");
    await user.click(screen.getByRole("button", { name: /다른 문장/ }));
    expect(screen.getByText("큐에 하나뿐인 문장.")).toBeInTheDocument();
  });

  it("연습 현황과 자주 틀리는 표현을 함께 보여준다", async () => {
    practiceYesterday({
      en: "A sentence with a repeated mistake.",
      ko: "같은 실수가 반복된 문장.",
      answer: "I goed to school yesterday.",
    });
    practiceYesterday({
      en: "Another sentence with the same mistake.",
      ko: "같은 실수가 또 나온 문장.",
      answer: "He goed home early.",
    });
    renderTab();

    expect(await screen.findByText(/복습 대기/)).toBeInTheDocument();
    expect(screen.getByText("2번")).toBeInTheDocument();
    const mistake = screen.getByText("goed").closest("li");
    expect(mistake).toHaveTextContent("went");
    // 통계 카드
    expect(screen.getByText("연속 연습")).toBeInTheDocument();
    expect(screen.getByText("2문장")).toBeInTheDocument();
    // 오늘 기록은 없다(어제만 연습함)
    expect(practiceId("classic", "A sentence with a repeated mistake.")).toBeTruthy();
  });
});

describe("ReviewTab — LLM 채점", () => {
  beforeEach(() => {
    evaluateMock.mockReset();
  });

  it("설정이 덜 됐으면 채점 대신 설정 안내를 보여준다", () => {
    practiceYesterday({
      en: "A sentence needing settings.",
      ko: "설정이 필요한 문장입니다.",
      answer: "answer",
    });
    render(
      <ReviewTab
        settings={{ host: "", model: "", apiKey: "" }}
        onGoSettings={() => {}}
      />,
    );
    expect(screen.getByText("LLM 설정이 아직 완성되지 않았어요.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /LLM 채점/ }),
    ).not.toBeInTheDocument();
  });

  it("쓴 문장을 LLM으로 채점하면 점수와 교정을 보여준다", async () => {
    practiceYesterday({
      en: "The rabbit hopped away quickly.",
      ko: "토끼가 잽싸게 뛰어가 버렸습니다.",
      answer: "old answer",
    });
    evaluateMock.mockResolvedValue({
      score: 64,
      feedback: "시제를 놓쳤어요.",
      corrections: [
        { original: "hop", better: "hopped", reason: "과거형이 필요합니다." },
      ],
      betterExpression: "The rabbit hopped away quickly.",
    });
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("토끼가 잽싸게 뛰어가 버렸습니다.");
    const box = screen.getByLabelText(/기억나는 대로 영어로 써보세요/);
    expect(screen.getByRole("button", { name: /LLM 채점/ })).toBeDisabled();

    await user.type(box, "The rabbit hop away quick.");
    await user.click(screen.getByRole("button", { name: /LLM 채점/ }));

    expect(await screen.findByText("64점")).toBeInTheDocument();
    expect(screen.getByText("시제를 놓쳤어요.")).toBeInTheDocument();
    expect(screen.getByText("hopped")).toBeInTheDocument();
    expect(
      await screen.findByText(/복습 채점 점수는 연습 기록 집계/),
    ).toBeInTheDocument();

    const args = evaluateMock.mock.calls[0];
    expect(args[0]).toEqual(SETTINGS);
    expect(args[1]).toBe("토끼가 잽싸게 뛰어가 버렸습니다.");
    expect(args[2]).toBe("The rabbit hop away quick.");
    expect(args[3]).toBe("The rabbit hopped away quickly.");
    expect(args[4]).toHaveProperty("signal");
  });

  it("취소한 채점은 오류로 보여주지 않는다", async () => {
    practiceYesterday({
      en: "Another sentence to cancel on.",
      ko: "취소할 문장입니다.",
      answer: "answer",
    });
    evaluateMock.mockImplementation(
      (_s: unknown, _k: string, _a: string, _r: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("abort")));
        }),
    );
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("취소할 문장입니다.");
    await user.type(screen.getByLabelText(/기억나는 대로/), "Some attempt here.");
    await user.click(screen.getByRole("button", { name: /LLM 채점/ }));
    await screen.findByText("채점 중…");
    await user.click(screen.getByRole("button", { name: /취소/ }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("취소할 문장입니다.")).toBeInTheDocument();
  });

  it("채점 실패는 오류 메시지로 알려준다", async () => {
    practiceYesterday({
      en: "A sentence that will fail scoring.",
      ko: "채점 실패 문장입니다.",
      answer: "answer",
    });
    evaluateMock.mockRejectedValue(new Error("호스트에 연결할 수 없습니다."));
    renderTab();
    const user = userEvent.setup();

    await screen.findByText("채점 실패 문장입니다.");
    await user.type(screen.getByLabelText(/기억나는 대로/), "An attempt to score.");
    await user.click(screen.getByRole("button", { name: /LLM 채점/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "호스트에 연결할 수 없습니다.",
    );
  });
});

describe("ReviewTab — 주간 그래프", () => {
  it("기록이 있으면 최근 8주 막대와 평균 점수를 보여준다", async () => {
    practiceYesterday({
      en: "A sentence for the weekly chart.",
      ko: "주간 그래프용 문장.",
      answer: "chart answer",
    });
    logPractice({
      lane: "classic",
      en: "An older sentence for the chart too.",
      ko: "지난 주 그래프용 문장.",
      answer: "older answer",
      score: 90,
      corrections: [],
      now: day(-9),
    });
    renderTab();

    expect(await screen.findByText("주간 연습량")).toBeInTheDocument();
    const chart = screen.getByRole("list", { name: "주간 연습량" });
    expect(chart).toBeInTheDocument();
    // 항목별 라벨이 스크린리더에 읽히는 구조인가 (role=img로 죽어 있지 않는다)
    const items = within(chart).getAllByRole("listitem");
    expect(
      items.some((li) => /문장/.test(li.getAttribute("aria-label") ?? "")),
    ).toBe(true);
    expect(screen.getAllByText("90점").length).toBeGreaterThan(0);
  });

  it("기록이 없으면 그래프를 그리지 않는다", () => {
    renderTab();
    expect(screen.queryByText("주간 연습량")).not.toBeInTheDocument();
  });
});

describe("ReviewTab — 자정을 넘기면 다시 계산한다 (리뷰 1-13)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("자정 전에 렌더해도 자정을 넘기면 대기 큐가 새로 계산된다", () => {
    vi.useFakeTimers();
    // 1/5 23:30 — 오늘(1/5) 연습한 문장의 복습 시점은 1/6
    vi.setSystemTime(new Date(2026, 0, 5, 23, 30, 0));
    logPractice({
      lane: "classic",
      en: "A sentence that becomes due after midnight.",
      ko: "자정 뒤에 복습 나오는 문장.",
      answer: "an attempt",
      score: 70,
      corrections: [],
      now: new Date(2026, 0, 5, 9, 0, 0),
    });

    renderTab();
    expect(screen.getByText("오늘 복습할 문장은 없습니다")).toBeInTheDocument();
    expect(screen.getByText(/다음 복습은 2026-01-06부/)).toBeInTheDocument();
    expect(screen.getByText("오늘")).toBeInTheDocument();
    expect(screen.getAllByText("1문장").length).toBeGreaterThan(0);

    // 로컬 자정을 넘어 1/6 00:15 — 저장소 변경 없이 큐가 갱신되어야 한다
    act(() => {
      vi.advanceTimersByTime(45 * 60 * 1000);
    });

    // fake timer 안에서는 findBy*(실제 타이머 필요)를 쓸 수 없다 → act 후 직접 확인한다
    expect(
      screen.getByText("자정 뒤에 복습 나오는 문장."),
    ).toBeInTheDocument();
    expect(screen.queryByText("오늘 복습할 문장은 없습니다")).not.toBeInTheDocument();
    expect(screen.getByText("0문장")).toBeInTheDocument();
  });
});

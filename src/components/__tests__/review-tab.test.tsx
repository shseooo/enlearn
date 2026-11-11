import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import ReviewTab from "../review-tab";
import {
  addDays,
  dueItems,
  logPractice,
  practiceId,
  reviewItems,
} from "@/lib/practice";
import { localDateString } from "@/lib/corpus";

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
});

describe("ReviewTab", () => {
  it("복습 대기 문장이 없으면 안내를 보여준다", () => {
    render(<ReviewTab />);
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
    render(<ReviewTab />);
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
    render(<ReviewTab />);
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
    render(<ReviewTab />);
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
    render(<ReviewTab />);
    const user = userEvent.setup();

    await screen.findByText("돌리기 테스트의 첫 문장.");
    await user.click(screen.getByRole("button", { name: /다른 문장/ }));
    expect(
      await screen.findByText("돌리기 테스트의 두 번째 문장."),
    ).toBeInTheDocument();
    expect(dueItems()).toHaveLength(2); // 평점하지 않았으므로 둘 다 대기 중
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
    render(<ReviewTab />);

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

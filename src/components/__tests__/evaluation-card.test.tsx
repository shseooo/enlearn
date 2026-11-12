import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EvaluationCard from "../evaluation-card";
import type { EvaluationResult, LLMSettings } from "@/lib/types";

const askFollowUpMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/llm", () => ({
  askFollowUp: askFollowUpMock,
}));

const baseResult: EvaluationResult = {
  score: 70,
  feedback: "전반적으로 좋아요.",
  corrections: [
    { original: "I am agree", better: "I agree", reason: "agree는 동사예요." },
  ],
  betterExpression: "I agree with you.",
};

const settings: LLMSettings = {
  host: "https://h.ai/v1",
  model: "m",
  apiKey: "k",
};

const context = { original: "I am agree with you." };

describe("EvaluationCard", () => {
  it("점수, 피드백, 개선 표현을 표시한다", () => {
    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);
    expect(screen.getByText("70")).toBeInTheDocument();
    expect(screen.getByText("전반적으로 좋아요.")).toBeInTheDocument();
    expect(screen.getByText("I am agree")).toBeInTheDocument();
    expect(screen.getByText("I agree")).toBeInTheDocument();
    expect(screen.getByText("agree는 동사예요.")).toBeInTheDocument();
    expect(screen.getByText("I agree with you.")).toBeInTheDocument();
  });

  it("corrections가 비어 있으면 해당 섹션을 표시하지 않는다", () => {
    render(
      <EvaluationCard
        result={{ ...baseResult, corrections: [] }}
        settings={settings}
        context={context}
      />,
    );
    expect(screen.queryByText("🔧 개선할 표현")).not.toBeInTheDocument();
  });

  it("referenceTranslation이 있으면 참고 번역을 표시한다", () => {
    render(
      <EvaluationCard
        result={{ ...baseResult, referenceTranslation: "I went to the park." }}
        settings={settings}
        context={context}
      />,
    );
    expect(screen.getByText("I went to the park.")).toBeInTheDocument();
    expect(screen.getByText("📖 참고 번역")).toBeInTheDocument();
  });
});

describe("EvaluationCard 추가 질문", () => {
  it("질문을 입력해 보내면 컨텍스트와 함께 요청되고 답변이 표시된다", async () => {
    askFollowUpMock.mockReset();
    askFollowUpMock.mockResolvedValue("went는 go의 과거형이에요. 예: I went home.");
    const user = userEvent.setup();
    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);

    await user.type(screen.getByLabelText("추가 질문"), "왜 went인가요?");
    await user.click(screen.getByRole("button", { name: "질문하기" }));

    expect(
      await screen.findByText("went는 go의 과거형이에요. 예: I went home."),
    ).toBeInTheDocument();
    expect(askFollowUpMock).toHaveBeenCalledWith(
      settings,
      context,
      baseResult,
      "왜 went인가요?",
      [],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("두 번째 질문에는 이전 질의응답이 히스토리로 전달된다", async () => {
    askFollowUpMock.mockReset();
    askFollowUpMock
      .mockResolvedValueOnce("첫 번째 답변입니다.")
      .mockResolvedValueOnce("두 번째 답변입니다.");
    const user = userEvent.setup();
    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);

    await user.type(screen.getByLabelText("추가 질문"), "첫 번째 질문");
    await user.click(screen.getByRole("button", { name: "질문하기" }));
    await screen.findByText("첫 번째 답변입니다.");

    await user.type(screen.getByLabelText("추가 질문"), "두 번째 질문");
    await user.click(screen.getByRole("button", { name: "질문하기" }));
    await screen.findByText("두 번째 답변입니다.");

    expect(askFollowUpMock).toHaveBeenLastCalledWith(
      settings,
      context,
      baseResult,
      "두 번째 질문",
      [{ question: "첫 번째 질문", answer: "첫 번째 답변입니다." }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("API 실패 시 오류가 표시되고 입력값은 유지된다", async () => {
    askFollowUpMock.mockReset();
    askFollowUpMock.mockRejectedValue(new Error("HTTP 500"));
    const user = userEvent.setup();
    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);

    await user.type(screen.getByLabelText("추가 질문"), "실패할 질문");
    await user.click(screen.getByRole("button", { name: "질문하기" }));

    expect(await screen.findByText(/오류:/)).toBeInTheDocument();
    expect(screen.getByLabelText("추가 질문")).toHaveValue("실패할 질문");
  });
});

describe("EvaluationCard — 추가 질문 히스토리 격리 (리뷰 3-3)", () => {
  it("결과가 새 객체로 바뀌면 이전 질문·답변을 지운다", async () => {
    askFollowUpMock.mockResolvedValue("현재형이 자연스럽습니다.");
    const { rerender } = render(
      <EvaluationCard result={baseResult} settings={settings} context={context} />,
    );

    await userEvent.type(screen.getByLabelText("추가 질문"), "왜 어색해요?");
    await userEvent.click(screen.getByRole("button", { name: /질문하기/ }));
    await screen.findByText(/왜 어색해요\?/);
    await screen.findByText("현재형이 자연스럽습니다.");

    rerender(
      <EvaluationCard
        result={{ ...baseResult, score: 88, feedback: "새 문장 평가입니다." }}
        settings={settings}
        context={{ original: "새로운 원문 문장" }}
      />,
    );

    expect(screen.getByText("새 문장 평가입니다.")).toBeInTheDocument();
    expect(screen.queryByText(/왜 어색해요\?/)).not.toBeInTheDocument();
    expect(screen.queryByText("현재형이 자연스럽습니다.")).not.toBeInTheDocument();
    expect((screen.getByLabelText("추가 질문") as HTMLTextAreaElement).value).toBe("");
  });

  it("답변이 도착할 때쯤 결과가 바뀌었다면 그 답변을 버린다", async () => {
    let resolve!: (value: string) => void;
    askFollowUpMock.mockImplementation(
      () => new Promise<string>((r) => (resolve = r)),
    );
    const { rerender } = render(
      <EvaluationCard result={baseResult} settings={settings} context={context} />,
    );

    await userEvent.type(screen.getByLabelText("추가 질문"), "지금 질문");
    await userEvent.click(screen.getByRole("button", { name: /질문하기/ }));

    rerender(
      <EvaluationCard
        result={{ ...baseResult, feedback: "이미 다른 문장 평가" }}
        settings={settings}
        context={{ original: "다른 원문" }}
      />,
    );
    resolve("늦게 도착한 답변");
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("늦게 도착한 답변")).not.toBeInTheDocument();
    expect(screen.getByText("이미 다른 문장 평가")).toBeInTheDocument();
  });
});

/*
 * R6-19(리뷰 5): 개선 표현을 옮겨 적는 복사 단추가 테스트에서 한 번도 눌리지 않았다.
 * 클립보드가 차단된 브라우저(권한 거부·http)에서는 조용히 넘어가야 한다.
 */
describe("EvaluationCard — 개선 표현 복사 (R6-19)", () => {
  it("복사하면 더 나은 표현이 클립보드로 가고 잠시 확인 표시를 한다", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);
    // userEvent.setup()이 자기 클립보드 목을 navigator.clipboard에 설치하므로,
    // 이 테스트만 fireEvent로 누른다(우리가 심은 writeText를 보고 싶다).
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("I agree with you.");
    expect(await screen.findByRole("button", { name: "복사됨 ✓" })).toBeInTheDocument();
  });

  it("클립보드가 차단된 환경에서는 조용히 넘어간다", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("NotAllowedError", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<EvaluationCard result={baseResult} settings={settings} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "복사" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "복사" })).toBeInTheDocument();
    expect(screen.queryByText("복사됨 ✓")).not.toBeInTheDocument();
  });
});

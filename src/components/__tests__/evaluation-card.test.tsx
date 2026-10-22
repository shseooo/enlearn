import { render, screen } from "@testing-library/react";
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

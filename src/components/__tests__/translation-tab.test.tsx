import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TranslationTab from "../translation-tab";

const { generateKoreanExerciseMock, evaluateTranslationMock } = vi.hoisted(() => ({
  generateKoreanExerciseMock: vi.fn(),
  evaluateTranslationMock: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  generateKoreanExercise: generateKoreanExerciseMock,
  evaluateTranslation: evaluateTranslationMock,
  DIFFICULTY_LABELS: {
    easy: "쉬움 — 기본 시제",
    normal: "보통 — 관용 표현",
    hard: "어려움 — 복잡한 구조",
  },
}));

const settings = { host: "https://h.ai/v1", model: "m", apiKey: "k" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TranslationTab", () => {
  it("주제 입력 후 문장을 받으면 문장과 접힌 힌트 섹션을 표시한다", async () => {
    generateKoreanExerciseMock.mockResolvedValue({
      sentence: "여행을 좋아합니다.",
      hints: ["like", "travel"],
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText(/주제/), "여행");
    await user.click(screen.getByRole("button", { name: /한국어 문장 받기/ }));

    expect(
      await screen.findByText("여행을 좋아합니다."),
    ).toBeInTheDocument();

    // 힌트는 접힌 상태(defaults) — 요약 라벨만 보이고 단어가 DOM에만 존재
    expect(screen.getByText(/힌트 단어 2개 보기/)).toBeInTheDocument();
    const details = screen
      .getByText(/힌트 단어 2개 보기/)
      .closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("like")).toBeInTheDocument();
    expect(screen.getByText("travel")).toBeInTheDocument();

    // 요청에 난이도와 주제가 전달된다
    expect(generateKoreanExerciseMock).toHaveBeenCalledWith(
      settings,
      "normal",
      "여행",
    );
  });

  it("힌트가 없으면 힌트 섹션을 표시하지 않는다", async () => {
    generateKoreanExerciseMock.mockResolvedValue({
      sentence: "안녕하세요.",
      hints: [],
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /한국어 문장 받기/ }));

    expect(await screen.findByText("안녕하세요.")).toBeInTheDocument();
    expect(screen.queryByText(/힌트 단어/)).not.toBeInTheDocument();
  });

  it("평가 요청에는 생성된 문장이 전달된다", async () => {
    generateKoreanExerciseMock.mockResolvedValue({
      sentence: "오늘 기분이 좋았다.",
      hints: ["feel", "happy"],
    });
    evaluateTranslationMock.mockResolvedValue({
      score: 90,
      feedback: "훌륭합니다.",
      corrections: [],
      betterExpression: "I felt happy today.",
      referenceTranslation: "I was in a good mood today.",
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /한국어 문장 받기/ }));
    await screen.findByText("오늘 기분이 좋았다.");
    await user.type(
      screen.getByLabelText(/내 영어 번역/),
      "Today I felt happy.",
    );
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));

    expect(evaluateTranslationMock).toHaveBeenCalledWith(
      settings,
      "오늘 기분이 좋았다.",
      "Today I felt happy.",
    );
    expect(
      await screen.findByText("I felt happy today."),
    ).toBeInTheDocument();
  });
});

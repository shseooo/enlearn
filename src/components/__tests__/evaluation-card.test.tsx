import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import EvaluationCard from "../evaluation-card";
import type { EvaluationResult } from "@/lib/types";

const baseResult: EvaluationResult = {
  score: 70,
  feedback: "전반적으로 좋아요.",
  corrections: [
    { original: "I am agree", better: "I agree", reason: "agree는 동사예요." },
  ],
  betterExpression: "I agree with you.",
};

describe("EvaluationCard", () => {
  it("점수, 피드백, 개선 표현을 표시한다", () => {
    render(<EvaluationCard result={baseResult} />);
    expect(screen.getByText("70")).toBeInTheDocument();
    expect(screen.getByText("전반적으로 좋아요.")).toBeInTheDocument();
    expect(screen.getByText("I am agree")).toBeInTheDocument();
    expect(screen.getByText("I agree")).toBeInTheDocument();
    expect(screen.getByText("agree는 동사예요.")).toBeInTheDocument();
    expect(screen.getByText("I agree with you.")).toBeInTheDocument();
  });

  it("corrections가 비어 있으면 해당 섹션을 표시하지 않는다", () => {
    render(<EvaluationCard result={{ ...baseResult, corrections: [] }} />);
    expect(screen.queryByText("🔧 개선할 표현")).not.toBeInTheDocument();
  });

  it("referenceTranslation이 있으면 참고 번역을 표시한다", () => {
    render(
      <EvaluationCard
        result={{ ...baseResult, referenceTranslation: "I went to the park." }}
      />,
    );
    expect(screen.getByText("I went to the park.")).toBeInTheDocument();
    expect(screen.getByText("📖 참고 번역")).toBeInTheDocument();
  });
});

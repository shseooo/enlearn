import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ScoreGauge, { scoreColor, scoreVerdict } from "../score-gauge";

describe("ScoreGauge", () => {
  it("점수를 텍스트로 표시한다", () => {
    render(<ScoreGauge score={85} />);
    expect(screen.getByText("85")).toBeInTheDocument();
  });

  it("접근성 라벨을 포함한다", () => {
    render(<ScoreGauge score={42} />);
    expect(
      screen.getByRole("img", { name: "점수: 42점" }),
    ).toBeInTheDocument();
  });

  it("점수를 0~100 사이로 클램핑해 표시한다", () => {
    const { rerender } = render(<ScoreGauge score={150} />);
    expect(screen.getByText("100")).toBeInTheDocument();
    rerender(<ScoreGauge score={-5} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("scoreColor / scoreVerdict", () => {
  it("점수별 색상을 반환한다", () => {
    expect(scoreColor(90)).toBe("#10b981");
    expect(scoreColor(70)).toBe("#f59e0b");
    expect(scoreColor(30)).toBe("#f43f5e");
  });

  it("점수별 평정을 반환한다", () => {
    expect(scoreVerdict(95)).toContain("완벽");
    expect(scoreVerdict(75)).toContain("조금만 더");
    expect(scoreVerdict(20)).toContain("연습");
  });
});

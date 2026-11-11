import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WeeklyChart from "../weekly-chart";
import type { WeekBucket } from "@/lib/practice";

const week = (o: Partial<WeekBucket>): WeekBucket => ({
  start: "2026-01-05",
  end: "2026-01-11",
  label: "1.5",
  count: 0,
  avgScore: 0,
  mistakes: 0,
  ...o,
});

describe("WeeklyChart", () => {
  it("연습이 전혀 없는 주에도 그려지고 빈칸으로 표시된다", () => {
    render(<WeeklyChart weeks={[week({}), week({ start: "2026-01-12", end: "2026-01-18", label: "1.12" })]} today="2026-01-12" />);
    const bars = screen.getAllByRole("listitem");
    expect(bars).toHaveLength(2);
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(screen.getAllByText("-")).toHaveLength(2);
  });

  it("문장 수와 평균 점수가 막대 위에/아래로 보인다", () => {
    render(
      <WeeklyChart
        weeks={[week({ count: 4, avgScore: 78, mistakes: 3 })]}
        today="2026-01-07"
      />,
    );
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("78점")).toBeInTheDocument();
    expect(screen.getByText("1.5")).toBeInTheDocument();
  });

  it("막대 개수보다 큰 값도 비율로 줄인다 (max 정규화)", () => {
    const { container } = render(
      <WeeklyChart
        weeks={[week({ count: 10 }), week({ count: 5, start: "2026-01-12", end: "2026-01-18", label: "1.12" })]}
        today="2026-01-07"
      />,
    );
    const heights = [...container.querySelectorAll('[style*="height"]')].map((el) =>
      (el as HTMLElement).style.height,
    );
    expect(heights).toContain("100%");
    expect(heights).toContain("50%");
  });

  it("그래프 전체 설명과 주별 설명이 접근 가능하다 (툴팁에 의존하지 않는다)", () => {
    render(<WeeklyChart weeks={[week({ count: 2, avgScore: 70, mistakes: 1 })]} today="2026-01-07" />);
    expect(screen.getByRole("img")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("1.5주 2문장"),
    );
    expect(screen.getByRole("listitem")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("2026-01-05 ~ 2026-01-11"),
    );
    expect(screen.getByRole("listitem")).toHaveAttribute("tabindex", "0");
  });
});

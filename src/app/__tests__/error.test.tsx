import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../error";

describe("앱 오류 경계", () => {
  it("오류 메시지와 다시 시도 단추를 보여준다", async () => {
    const reset = vi.fn();
    render(<ErrorBoundary error={new Error("Objects are not valid as a React child")} reset={reset} />);
    expect(
      screen.getByText("화면을 그리는 중에 문제가 생겼습니다"),
    ).toBeInTheDocument();
    expect(screen.getByText("Objects are not valid as a React child")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /다시 시도/ }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("메시지가 없어도 크래시하지 않는다", () => {
    render(<ErrorBoundary error={new Error("")} reset={() => {}} />);
    expect(screen.getByText("알 수 없는 오류")).toBeInTheDocument();
  });
});

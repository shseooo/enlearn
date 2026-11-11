import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import Home from "../page";

beforeEach(() => {
  window.localStorage.clear();
});

describe("앱 셸", () => {
  it("탭은 tablist / tab / tabpanel 규칙을 따른다", () => {
    render(<Home />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);

    expect(screen.getByRole("tab", { name: /자유 작성/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: /번역 연습/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // 선택되지 않은 탭은 tab순회에서 빠진다 (화살표 키로 이동)
    expect(screen.getByRole("tab", { name: /번역 연습/ })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByRole("tabpanel", { name: /자유 작성/ })).toBeInTheDocument();
  });

  it("탭을 옮긴 뒤 돌아오면 입력한 문장이 남아있다", async () => {
    render(<Home />);
    const user = userEvent.setup();
    const box = screen.getByLabelText(/영문으로 문장을 작성해보세요/);
    await user.type(box, "I goed to the park.");

    await user.click(screen.getByRole("tab", { name: /번역 연습/ }));
    expect(screen.getByRole("tabpanel", { name: /번역 연습/ })).not.toHaveAttribute(
      "hidden",
    );

    await user.click(screen.getByRole("tab", { name: /자유 작성/ }));
    expect(box).toHaveValue("I goed to the park.");
  });

  it("화살표 키로 탭을 이동하고 포커스를 옮긴다", async () => {
    render(<Home />);
    const user = userEvent.setup();

    screen.getByRole("tab", { name: /자유 작성/ }).focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: /번역 연습/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /번역 연습/ }),
    );
  });

  it("코퍼스 출처(라이선스)를 화면 하단에 표기한다", () => {
    render(<Home />);
    expect(screen.getByText(/CC-BY 2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Project Gutenberg/)).toBeInTheDocument();
  });
});

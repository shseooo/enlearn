import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Home from "../page";
import { logPractice } from "@/lib/practice";

beforeEach(() => {
  window.localStorage.clear();
});

describe("앱 셸", () => {
  it("탭은 tablist / tab / tabpanel 규칙을 따른다", () => {
    render(<Home />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(4);

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
    const panel = screen.getByRole("tabpanel", { name: /자유 작성/ });
    expect(panel).toBeInTheDocument();
    // 키보드로 패널 안에 들어갈 수 있어야 한다
    expect(panel).toHaveAttribute("tabindex", "0");
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

  it("복습 탭 패널이 tabpanel 규칙으로 연결된다", async () => {
    render(<Home />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /복습/ }));
    expect(screen.getByRole("tab", { name: /복습/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tabpanel", { name: /복습/ })).toBeInTheDocument();
  });

  it("코퍼스 출처(라이선스)를 화면 하단에 표기한다", () => {
    render(<Home />);
    expect(screen.getByText(/CC-BY 2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Project Gutenberg/)).toBeInTheDocument();
  });

  it("저장 실패 안내는 복습 탭이 아닌 곳에서도 보인다 (리뷰 1-8)", async () => {
    render(<Home />);
    const user = userEvent.setup();
    // 쓰기가 일어나는 탭(번역 연습)에 머물러 있다.
    await user.click(screen.getByRole("tab", { name: /번역 연습/ }));

    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    act(() => {
      logPractice({
        lane: "classic",
        en: "A sentence that cannot be stored.",
        ko: "저장되지 않는 문장.",
        answer: "attempt",
        score: 55,
        corrections: [],
      });
    });
    spy.mockRestore();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /저장 공간이 가득 찼습니다/,
    );
  });
});

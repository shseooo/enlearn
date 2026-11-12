import { render, screen, act, within } from "@testing-library/react";
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

  /*
   * R6-22(리뷰 5): 네 개의 탭을 다 마운트해 두지만(hidden 전환), 셸 테스트는
   * 자유 작성 패널만 봤다. 번역·복습·설정 탭의 첫 렌더가 깨져도 셸 테스트는
   * 통과했다 — 아래 두 테스트가 그 렌더를 실제로 지나가게 한다.
   */
  it("설정 탭으로 옮기면 연결 설정 입력이 실제로 렌더된다 (R6-22)", async () => {
    render(<Home />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: /설정/ }));

    const panel = screen.getByRole("tabpanel", { name: /설정/ });
    expect(panel).not.toHaveAttribute("hidden");
    expect(within(panel).getByPlaceholderText("https://api.openai.com/v1")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /연결 테스트/ })).toBeInTheDocument();
  });

  it("복습 탭으로 옮기면 연습 통계가 실제로 렌더된다 (R6-22)", async () => {
    logPractice({
      lane: "classic",
      en: "A logged sentence for the shell test.",
      ko: "기록된 문장.",
      answer: "attempt",
      score: 70,
      corrections: [],
    });
    render(<Home />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: /복습/ }));

    const panel = screen.getByRole("tabpanel", { name: /복습/ });
    expect(panel).not.toHaveAttribute("hidden");
    // "오늘 1문장"·"연속 1문장"처럼 통계 조각이 여러 개 렌더된다.
    expect(within(panel).getAllByText("1문장").length).toBeGreaterThan(0);
  });

  // D3-1(R6-5): 같은 브라우저에서 두 탭이 열리면 저장이 서로를 덮는다.
  it("다른 탭이 열리면 저장소를 쓰는 어디에서나 안내가 보인다 (D3-1)", async () => {
    render(<Home />);
    expect(screen.queryByText(/다른 탭에서도 열려 있습니다/)).not.toBeInTheDocument();

    const peer = new BroadcastChannel("enlearn:tab");
    peer.postMessage({ type: "join", id: "other-tab" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await screen.findByText(/다른 탭에서도 열려 있습니다/)).toBeInTheDocument();

    peer.postMessage({ type: "leave", id: "other-tab" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/다른 탭에서도 열려 있습니다/)).not.toBeInTheDocument();
    peer.close();
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

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FreeWritingTab from "../free-writing-tab";
import type { LLMSettings } from "@/lib/types";

const { evaluateMock } = vi.hoisted(() => ({ evaluateMock: vi.fn() }));

vi.mock("@/lib/llm", () => ({
  evaluateFreeWriting: evaluateMock,
  askFollowUp: vi.fn(),
}));

const settings: LLMSettings = {
  host: "https://h.ai/v1",
  model: "m",
  apiKey: "k",
};

const result = {
  score: 78,
  feedback: "과거형을 쓰면 좋아요.",
  corrections: [{ original: "go", better: "went", reason: "과거형" }],
  betterExpression: "Yesterday I went to the park.",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("FreeWritingTab", () => {
  it("설정이 완성되기 전에는 평가를 막고 안내한다", async () => {
    render(
      <FreeWritingTab
        settings={{ ...settings, apiKey: "" }}
        onGoSettings={() => {}}
      />,
    );
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText("영문으로 문장을 작성해보세요"),
      "I goed to the park.",
    );

    expect(screen.getByRole("button", { name: "점수 받기" })).toBeDisabled();
    expect(screen.getByText(/LLM 설정이 아직 완성되지 않았어요/)).toBeInTheDocument();
  });

  it("문장을 평가하면 취소 가능한 signal과 함께 요청하고 결과를 보여준다", async () => {
    evaluateMock.mockResolvedValue(result);
    render(<FreeWritingTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText("영문으로 문장을 작성해보세요"),
      "  Yesterday I go to the park.  ",
    );
    await user.click(screen.getByRole("button", { name: "점수 받기" }));

    expect(await screen.findByText("Yesterday I went to the park.")).toBeInTheDocument();
    const [usedSettings, sentence, options] = evaluateMock.mock.calls[0] as [
      LLMSettings,
      string,
      { signal: AbortSignal },
    ];
    expect(usedSettings).toEqual(settings);
    expect(sentence).toBe("Yesterday I go to the park.");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("취소 버튼을 누르면 스피너만 사라지고 오류를 보여 주지 않는다", async () => {
    evaluateMock.mockImplementation(
      (_s: LLMSettings, _t: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    render(<FreeWritingTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText("영문으로 문장을 작성해보세요"),
      "I goed to the park.",
    );
    await user.click(screen.getByRole("button", { name: "점수 받기" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/오류/)).not.toBeInTheDocument();
    expect(evaluateMock).toHaveBeenCalledTimes(1);
  });

  it("평가가 실패하면 오류를 보여주고 결과를 비운다", async () => {
    evaluateMock.mockRejectedValue(new Error("HTTP 401 Unauthorized"));
    render(<FreeWritingTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText("영문으로 문장을 작성해보세요"),
      "I goed to the park.",
    );
    await user.click(screen.getByRole("button", { name: "점수 받기" }));

    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(screen.queryByText(/더 좋은 전체 표현/)).not.toBeInTheDocument();
  });
});

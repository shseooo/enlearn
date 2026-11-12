import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SettingsTab from "../settings-tab";
import type { LLMSettings } from "@/lib/types";

const settings: LLMSettings = {
  host: "https://h.ai/v1",
  model: "m",
  apiKey: "k",
};

describe("SettingsTab", () => {
  it("저장하면 onSaved가 한 번만 불린다 (localStorage·변경 이벤트 이중 발생 방지)", async () => {
    const onSaved = vi.fn();
    render(<SettingsTab settings={settings} onSaved={onSaved} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "저장" }));

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(settings);
  });

  it("API 키가 없어도 저장·연결 테스트를 사용할 수 있다 (Ollama 등)", async () => {
    const onSaved = vi.fn();
    const keyless: LLMSettings = {
      host: "http://localhost:11434/v1",
      model: "m",
      apiKey: "",
    };
    render(<SettingsTab settings={keyless} onSaved={onSaved} />);
    const user = userEvent.setup();

    expect(screen.getByRole("button", { name: /연결 테스트/ })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(onSaved).toHaveBeenCalledWith(keyless);
  });

  it("다른 탭에서 저장된 값이 바뀌면 입력창이 따라간다", () => {
    const { rerender } = render(
      <SettingsTab settings={settings} onSaved={() => {}} />,
    );

    rerender(
      <SettingsTab
        settings={{ ...settings, model: "gpt-new" }}
        onSaved={() => {}}
      />,
    );

    expect(screen.getByLabelText("Model")).toHaveValue("gpt-new");
  });

  it("저장하지 않은 편집 중에는 외부 변경이 입력창을 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SettingsTab settings={settings} onSaved={() => {}} />,
    );
    const modelInput = screen.getByLabelText("Model");

    await user.type(modelInput, "-draft");
    rerender(
      <SettingsTab
        settings={{ ...settings, model: "gpt-new" }}
        onSaved={() => {}}
      />,
    );

    expect(modelInput).toHaveValue("m-draft");
    expect(screen.getByText(/저장하지 않은 변경/)).toBeInTheDocument();
  });

  it("Host가 잘못되면 저장을 막고 이유를 보여준다", async () => {
    const user = userEvent.setup();
    render(<SettingsTab settings={settings} onSaved={() => {}} />);

    const hostInput = screen.getByLabelText("Host");
    await user.clear(hostInput);
    await user.type(hostInput, "::::");

    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
    expect(screen.getByText(/해석할 수 없습니다/)).toBeInTheDocument();
  });

  it("올바른 Host면 실제로 요청할 주소를 미리 보여준다", () => {
    render(<SettingsTab settings={settings} onSaved={() => {}} />);
    expect(screen.getByText("요청 대상: https://h.ai/v1/chat/completions")).toBeInTheDocument();
  });
});

const testConnectionMock = vi.hoisted(() => vi.fn());

// 실제 checkHost는 살리고 testConnection만 대체한다 (host 검증 테스트가 함께 있어서)
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  return {
    ...actual,
    testConnection: (...args: unknown[]) => testConnectionMock(...args),
  };
});

describe("SettingsTab — 연결 테스트 취소 (리뷰 3-10)", () => {
  it("취소하면 오류로 표시하지 않고 '테스트 중…'에서 빠져나온다", async () => {
    testConnectionMock.mockImplementation(
      (_settings: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    render(
      <SettingsTab settings={settings} onSaved={() => {}} />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /연결 테스트/ }));
    expect(await screen.findByText("테스트 중...")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /취소/ }));
    await new Promise((r) => setTimeout(r, 0));

    // 아래 "실패하면 role=alert" 테스트가 같은 배너를 잡아 주기 때문에
    // 이 부재 단언은 항상 참이 아니다(리뷰 2-3).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /연결 테스트/ }),
    ).toBeEnabled();
    expect(testConnectionMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "https://h.ai/v1" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("연결 테스트가 실패하면 오류를 role=alert로 보여준다 (리뷰 2-3)", async () => {
    testConnectionMock.mockRejectedValue(new Error("Host를 확인할 수 없습니다"));

    render(<SettingsTab settings={settings} onSaved={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /연결 테스트/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Host를 확인할 수 없습니다/,
    );
  });

  // R6-19(리뷰 5): 성공 배너는 이 화면의 유일한 "정상" 신호인데 테스트가 없었다.
  it("연결 테스트가 성공하면 응답 조각을 배너로 보여준다 (R6-19)", async () => {
    testConnectionMock.mockResolvedValue("pong");

    render(<SettingsTab settings={settings} onSaved={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /연결 테스트/ }));

    expect(await screen.findByText(/연결 성공! LLM 응답: pong/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /연결 테스트/ })).toBeEnabled();
  });
});

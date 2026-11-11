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

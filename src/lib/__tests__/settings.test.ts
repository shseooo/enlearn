import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  getSettingsServerSnapshot,
  getSettingsSnapshot,
  isSettingsComplete,
  loadSettings,
  saveSettings,
  subscribeToSettings,
} from "../settings";

const KEY = "enlearn.settings";

beforeEach(() => {
  window.localStorage.clear();
});

describe("loadSettings", () => {
  it("저장된 값이 없으면 기본값을 반환한다", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("저장 후 로드 라운드트립이 동작한다", () => {
    const s = { host: "https://h.ai/v1", model: "m", apiKey: "k" };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("JSON이 깨져 있으면 기본값을 반환한다", () => {
    window.localStorage.setItem(KEY, "{bad json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("객체가 아니면 기본값을 반환한다", () => {
    window.localStorage.setItem(KEY, '"just a string"');
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("부분적으로만 저장된 필드도 보완한다", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ host: "https://h.ai" }));
    expect(loadSettings()).toEqual({
      host: "https://h.ai",
      model: DEFAULT_SETTINGS.model,
      apiKey: "",
    });
  });
});

describe("isSettingsComplete", () => {
  it("host/model/apiKey가 모두 있으면 true", () => {
    expect(
      isSettingsComplete({ host: "h", model: "m", apiKey: "k" }),
    ).toBe(true);
  });

  it("어느 하나라도 비어 있으면 false", () => {
    expect(isSettingsComplete({ host: "", model: "m", apiKey: "k" })).toBe(
      false,
    );
    expect(isSettingsComplete({ host: "h", model: "", apiKey: "k" })).toBe(
      false,
    );
    expect(isSettingsComplete({ host: "h", model: "m", apiKey: "  " })).toBe(
      false,
    );
  });
});

describe("useSyncExternalStore 스냅샷", () => {
  it("값이 안 바뀌면 같은 참조를 반환한다 (재렌더 방지)", () => {
    const a = getSettingsSnapshot();
    const b = getSettingsSnapshot();
    expect(a).toBe(b);
  });

  it("saveSettings 후 새 스냅샷이 반환된다", () => {
    const before = getSettingsSnapshot();
    saveSettings({ host: "h", model: "m", apiKey: "k" });
    const after = getSettingsSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual({ host: "h", model: "m", apiKey: "k" });
  });

  it("saveSettings 호출 시 구독자에게 알림을 보낸다", () => {
    const spy = vi.fn();
    const unsubscribe = subscribeToSettings(spy);
    saveSettings({ host: "h", model: "m", apiKey: "k" });
    expect(spy).toHaveBeenCalled();
    unsubscribe();
  });

  it("서버 스냅샷은 참조가 항상 안정된 기본값이다", () => {
    expect(getSettingsServerSnapshot()).toBe(DEFAULT_SETTINGS);
    expect(getSettingsServerSnapshot()).toBe(getSettingsServerSnapshot());
  });
});

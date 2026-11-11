import { describe, expect, it, vi } from "vitest";
import { clearStorageError, safeSetItem, storageError } from "../storage";

describe("safeSetItem (리뷰 3-9)", () => {
  it("정상 저장은 true, 이후 오류 기록은 비워진다", () => {
    clearStorageError();
    expect(safeSetItem("probe.key", "value")).toBe(true);
    expect(window.localStorage.getItem("probe.key")).toBe("value");
    expect(storageError()).toBeNull();
    window.localStorage.removeItem("probe.key");
  });

  it("용량 초과는 삼키고 안내 문구를 남긴다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    expect(safeSetItem("probe.key", "x")).toBe(false);
    expect(storageError()).toMatch(/저장 공간이 가득 찼습니다/);
    vi.spyOn(Storage.prototype, "setItem").mockRestore();
  });

  it("그 밖의 저장 실패도 일반 안내로 남긴다", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Unexpected private mode failure");
    });
    expect(safeSetItem("probe.key", "x")).toBe(false);
    expect(storageError()).toBe("브라우저에 저장하지 못했습니다.");
    vi.spyOn(Storage.prototype, "setItem").mockRestore();
    clearStorageError();
    expect(storageError()).toBeNull();
  });

  it("이전 값은 그대로 남아 있다 (쓰기 실패가 지우기로 이어지지 않는다)", () => {
    safeSetItem("probe.keep", "original");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });
    safeSetItem("probe.keep", "replacement");
    vi.spyOn(Storage.prototype, "setItem").mockRestore();
    expect(window.localStorage.getItem("probe.keep")).toBe("original");
    window.localStorage.removeItem("probe.keep");
  });
});

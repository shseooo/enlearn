import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StorageWarning from "../storage-warning";
import { clearStorageError, storageError } from "@/lib/storage";
import { markSeen } from "@/lib/corpus";

/** 쓰기를 실패시키는 목 (용량 초과를 가장한다) */
function failWrites() {
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("QuotaExceededError", "QuotaExceededError");
  });
}

describe("StorageWarning — 저장 실패를 모든 탭에서 보여준다 (리뷰 1-8)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearStorageError();
    vi.restoreAllMocks();
  });

  it("저장 실패가 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<StorageWarning />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("쓰기가 실패한 그 화면에서 즉시 안내가 나타난다 (스냅샷 갱신)", async () => {
    const { container } = render(<StorageWarning />);
    expect(container).toBeEmptyDOMElement();

    const spy = failWrites();
    act(() => {
      markSeen("daily:1:unsaved");
    });
    spy.mockRestore();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/저장 공간이 가득 찼습니다/);
  });

  it("다시 저장이 성공하면 안내가 저절로 사라진다", async () => {
    const spy = failWrites();
    act(() => {
      markSeen("daily:1:unsaved");
    });
    spy.mockRestore();
    render(<StorageWarning />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    act(() => {
      markSeen("daily:2:saved");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(storageError()).toBeNull();
  });

  it("닫기 버튼으로 안내를 지울 수 있다 (리뷰 1-14)", async () => {
    const spy = failWrites();
    act(() => {
      markSeen("daily:1:unsaved");
    });
    spy.mockRestore();

    render(<StorageWarning />);
    const user = userEvent.setup();
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /닫기/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(storageError()).toBeNull();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BackupCard from "../backup-card";
import { loadLog, logPractice } from "@/lib/practice";
import { BACKUP_APP } from "@/lib/backup";

const VALID = JSON.stringify({
  app: BACKUP_APP,
  version: 1,
  exportedAt: "2026-01-02T00:00:00.000Z",
  counts: { log: 1, srs: 1, seen: 0, koreanCache: 0 },
  data: {
    log: [
      {
        date: "2026-01-02",
        lane: "classic",
        en: "Sentence coming from a backup file.",
        ko: "백업에서 온 문장.",
        answer: "backup answer",
        score: 91,
        corrections: [{ original: "goed", better: "went" }],
      },
    ],
    srs: [
      {
        id: "classic:b1",
        lane: "classic",
        en: "Queue sentence coming from a backup.",
        ko: "백업에서 온 큐 문장.",
        stage: 1,
        due: "2099-01-01",
        lapses: 0,
        lastReviewed: "2026-01-02",
      },
    ],
    seen: {},
    koreanCache: {},
  },
});

function fileOf(text: string, name = "backup.json") {
  return new File([text], name, { type: "application/json" });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("BackupCard", () => {
  it("내보내기는 파일을 저장하고 개수를 알려준다", async () => {
    logPractice({
      lane: "classic",
      en: "A sentence to back up.",
      ko: "백업할 문장.",
      answer: "answer",
      score: 70,
      corrections: [],
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:fake");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /백업 내보내기/ }));

    expect(await screen.findByText(/저장했습니다/)).toHaveTextContent("기록 1개");
    expect(clicks[0]).toMatch(/^enlearn-backup-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it("가져오기는 내용을 미리 보여준 뒤 합칠 수 있다", async () => {
    logPractice({
      lane: "classic",
      en: "Existing sentence before import.",
      ko: "가져오기 전 문장.",
      answer: "existing",
      score: 60,
      corrections: [],
    });
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(VALID, "my-backup.json"),
    );

    expect(
      await screen.findByText(/2026-01-02에 내보낸 백업/),
    ).toBeInTheDocument();
    expect(screen.getByText(/기록 1개 · 복습 큐 1개/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));
    expect(await screen.findByText(/을\(를\) 합쳤습니다/)).toBeInTheDocument();

    const log = loadLog();
    expect(log).toHaveLength(2);
    expect(log.map((r) => r.en)).toContain("Sentence coming from a backup file.");
  });

  it("다른 앱 백업·형식이 잘못된 파일은 오류로 알려준다", async () => {
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf("숫자가 아니라서요"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/올바른 JSON/);

    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(JSON.stringify({ app: "not-enlearn", data: { log: [] } }), "other.json"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /enlearn 백업 파일이 아닙니다/,
    );
  });

  it("대체는 확인 창을 거쳐 기존 기록을 지운다", async () => {
    logPractice({
      lane: "classic",
      en: "Record that will be replaced.",
      ko: "대체될 문장.",
      answer: "old",
      score: 50,
      corrections: [],
    });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf(VALID));
    await user.click(screen.getByRole("button", { name: /기존 기록을 지우고 대체/ }));

    expect(confirm).toHaveBeenCalled();
    await screen.findByText(/기존 기록을 대체했습니다/);
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].en).toBe("Sentence coming from a backup file.");
  });

  it("취소하면 아무것도 바뀌지 않는다", async () => {
    logPractice({
      lane: "classic",
      en: "Untouched record here.",
      ko: "그대로 남는 문장.",
      answer: "keep",
      score: 65,
      corrections: [],
    });
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf(VALID));
    await screen.findByText(/2026-01-02에 내보낸 백업/);
    await user.click(screen.getByRole("button", { name: /^취소$/ }));

    await waitFor(() =>
      expect(screen.queryByText(/2026-01-02에 내보낸 백업/)).not.toBeInTheDocument(),
    );
    expect(loadLog()).toHaveLength(1);
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BackupCard from "../backup-card";
import { loadLog, logPractice } from "@/lib/practice";
import { saveSettings } from "@/lib/settings";
import { BACKUP_APP, buildBackup } from "@/lib/backup";

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

describe("BackupCard — 연결 설정 되돌리기 (3-1)", () => {
  const fileWithSettings = (host: string) =>
    JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      data: {
        log: [],
        srs: [],
        settings: { host, model: "restored-model" },
      },
    });

  it("기본은 꺼져 있고, 켜지 않으면 지금의 연결 설정이 그대로다", async () => {
    saveSettings({ host: "https://mine.example.com/v1", model: "mine", apiKey: "sk-mine" });
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(fileWithSettings("http://collector.example.net/v1")),
    );

    const checkbox = screen.getByRole("checkbox", { name: /연결 설정도 되돌리기/ });
    expect(checkbox).not.toBeChecked();
    expect(
      screen.getByText("http://collector.example.net/v1/chat/completions"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));
    await screen.findByText(/합쳤습니다/);
    const saved = window.localStorage.getItem("enlearn.settings") ?? "";
    expect(saved).toContain("mine.example.com");
    expect(saved).not.toContain("collector");
  });

  it("확인하고 켜면 host/model만 반영되고 API 키는 그대로다", async () => {
    saveSettings({ host: "https://mine.example.com/v1", model: "mine", apiKey: "sk-mine" });
    render(<BackupCard />);
    const user = userEvent.setup();

    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(fileWithSettings("https://backup.example.com/v1")),
    );
    await user.click(screen.getByRole("checkbox", { name: /연결 설정도 되돌리기/ }));
    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));

    await screen.findByText(/연결 설정/);
    const saved = window.localStorage.getItem("enlearn.settings") ?? "";
    expect(saved).toContain("backup.example.com");
    expect(saved).toContain("restored-model");
    expect(saved).toContain("sk-mine");
  });

  it("원격 http 호스트면 키가 평문으로 간다고 경고한다", async () => {
    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(fileWithSettings("http://collector.example.net/v1")),
    );
    expect(await screen.findByText(/평문으로 전송/)).toBeInTheDocument();
  });

  it("검증되지 않는 host는 미리보기에 나타나지 않는다", async () => {
    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      fileOf(fileWithSettings("ftp://collector.example.net/v1")),
    );
    await screen.findByText(/지금 기록에 합치기/);
    expect(
      screen.queryByRole("checkbox", { name: /연결 설정도 되돌리기/ }),
    ).not.toBeInTheDocument();
  });
});

describe("BackupCard — 저장 실패 안내 (리뷰 3-9)", () => {
  it("저장 공간이 가득 찼으면 조용히 넘어가지 않고 안내한다", async () => {
    logPractice({
      lane: "classic",
      en: "Existing stored sentence.",
      ko: "이미 저장된 문장.",
      answer: "existing",
      score: 60,
      corrections: [],
    });
    const text = JSON.stringify(buildBackup(false));
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      new File([text], "enlearn-backup.json", { type: "application/json" }),
    );
    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));

    expect(
      await screen.findByText(/저장 공간이 가득 찼습니다/),
    ).toBeInTheDocument();
    spy.mockRestore();
  });
});

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BackupCard from "../backup-card";
import StorageWarning from "../storage-warning";
import { loadLog, logPractice, MAX_RECORDS, reviewItems } from "@/lib/practice";
import { cacheKorean, getCachedKorean, markSeen, seenCount } from "@/lib/corpus";
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

  /*
   * R8-2: 확인 문구가 실제로 지우는 네 저장소 중 받은 문장 기록(seen, 상한 2만 건)을
   * 빠뜨렸다. 백업에 seen 섹션이 없으면 parseBackup이 {}로 채우므로, 문구를 읽은
   * 사용자는 "기록은 남는 줄 알고" 그 기록을 잃는다(D1-1의 되돌릴 수 없음 고지).
   * D8-1(백업에 없는 섹션의 의미)이 정해질 때까지 현행 동작도 함께 고정한다.
   */
  it("대체 확인 문구는 지워지는 저장소를 모두 적고, seen 없는 백업은 seen을 빈 값으로 대체한다 (R8-2)", async () => {
    markSeen("classic:seen:one");
    markSeen("classic:seen:two");
    expect(seenCount()).toBe(2);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf(VALID));
    await user.click(
      screen.getByRole("button", { name: /기존 기록을 지우고 대체/ }),
    );
    await screen.findByText(/기존 기록을 대체했습니다/);

    const asked = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(asked).toMatch(/받은 문장/);
    expect(asked).toMatch(/되돌릴 수 없습니다/);
    // VALID의 seen 섹션은 빈 객체({}) — 지금은 그것까지 포함해 대체한다.
    expect(seenCount()).toBe(0);
  });

  /*
   * D8-1: 백업 파일에 없는 섹션은 "0개로 대체"가 아니라 "그대로 남음"이다.
   * 확인 창과 결과 문구가 그 사실을 말하고, 저장소도 그대로 남아야 한다.
   */
  it("백업에 없는 섹션은 그대로 남고, 확인 창과 결과 문구가 그 사실을 말해준다 (D8-1)", async () => {
    logPractice({
      lane: "classic",
      en: "Record that must survive a partial backup.",
      ko: "부분 백업으로 살아남는 기록.",
      answer: "keep",
      score: 60,
      corrections: [],
    });
    markSeen("classic:keep:seen");
    cacheKorean("classic:keep:ko", "살아남는 번역.", ["keep"]);

    const partial = JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      exportedAt: "2026-01-02T00:00:00.000Z",
      counts: { log: 0, srs: 1, seen: 0, koreanCache: 0 },
      data: {
        // log·seen·koreanCache 섹션 자체가 없는 파일
        srs: [
          {
            id: "classic:partial",
            lane: "classic",
            en: "Queue entry from a partial backup.",
            ko: "부분 백업의 큐 항목.",
            stage: 1,
            due: "2099-01-01",
            lapses: 0,
            lastReviewed: null,
          },
        ],
      },
    });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf(partial));
    await user.click(screen.getByRole("button", { name: /기존 기록을 지우고 대체/ }));

    const asked = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(asked).toMatch(/이 백업에 없는 섹션/);
    expect(asked).toMatch(/그대로 남습니다/);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/이 백업에 없는 섹션: 연습 기록·받은 문장 기록·번역 캐시 \(그대로 남음\)/);
    // 실제로도 남아 있다.
    expect(loadLog().map((r) => r.en)).toContain(
      "Record that must survive a partial backup.",
    );
    expect(seenCount()).toBe(1);
    expect(getCachedKorean("classic:keep:ko")?.ko).toBe("살아남는 번역.");
    // 적혀 있던 섹션(srs)은 대체된다.
    expect(reviewItems().map((x) => x.id)).toEqual(["classic:partial"]);
  });

  /*
   * R8-6: 번역 캐시에는 시각 비교가 없다(기존 값 우선 — D2-1). "더 최근 기록이 있어
   * 적용되지 않음"은 사용자에게 "내 백업이 옛것이어서 거부됐다"는 거짓 설명이고,
   * 실제로는 어떤 번역도 백업의 것으로 바꿀 수 없다는 사실을 감춘다.
   */
  it("번역 캐시가 겹치는 합치기는 '더 최근'이 아니라 '이미 저장된 값'이라고 말한다 (R8-6)", async () => {
    cacheKorean("classic:overlap:key", "화면에 이미 있는 번역.", ["old"]);
    const backup = JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      exportedAt: "2026-01-02T00:00:00.000Z",
      counts: { log: 1, srs: 0, seen: 0, koreanCache: 1 },
      data: {
        log: [
          {
            date: "2026-01-02",
            lane: "classic",
            en: "Fresh record for the cache wording test.",
            ko: "번역 캐시 문구 테스트용 기록.",
            answer: "answer",
            score: 80,
            corrections: [],
          },
        ],
        srs: [],
        seen: {},
        koreanCache: {
          "classic:overlap:key": { ko: "백업에 있던 번역.", hints: ["backup"] },
        },
      },
    });

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/백업 가져오기/), fileOf(backup));
    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/1건은 이미 저장된 값이 있어 적용되지 않음/);
    expect(status.textContent).not.toMatch(/더 최근/);
    // D8-2: 카드의 정적 안내도 번역 캐시에 거짓말하지 않도록 나뉘었다.
    expect(
      screen.getByText(/이미 번역된 문장의 번역은 백업으로 바뀌지 않습니다/),
    ).toBeInTheDocument();
    expect(screen.getByText(/합치기는 연습 기록·복습 큐·받은 문장에서 더 최근 기록/)).toBeInTheDocument();
    // 실제로는 기존 번역이 그대로 남는다 — 백업의 번역은 어디로도 반영되지 않는다.
    expect(getCachedKorean("classic:overlap:key")?.ko).toBe("화면에 이미 있는 번역.");
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

describe("BackupCard — 큰 파일 거부 (리뷰 1-16)", () => {
  it("지정 크기를 넘는 파일은 읽지 않고 안내한다", async () => {
    render(<BackupCard />);
    const user = userEvent.setup();
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "huge.json", {
      type: "application/json",
    });

    await user.upload(screen.getByLabelText(/백업 가져오기/), huge);

    expect(await screen.findByRole("alert")).toHaveTextContent(/너무 큽니다/);
    // 미리보기(합치기/대체 버튼)가 뜨면 안 된다
    expect(screen.queryByRole("button", { name: /지금 기록에 합치기/ })).toBeNull();
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

    // 저장이 일어난 탭과 무관하게 안내가 보이도록, StorageWarning은 화면 상위에서
    // 한 번만 마운트한다(page.tsx). 여기서는 그 배치를 그대로 재현한다(리뷰 1-8).
    render(
      <>
        <BackupCard />
        <StorageWarning />
      </>,
    );
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

  // 리뷰 2-4: 쓰기가 실패해도 개수는 이전 값을 세므로, "대체했습니다" 문구가
  // 그대로 보이면 사용자는 없는 결과를 믿는다.
  it("대체가 실패하면 성공 문구 대신 실패 안내를 보여준다 (리뷰 2-4)", async () => {
    logPractice({
      lane: "classic",
      en: "Sentence that must survive a failed replace.",
      ko: "남아 있는 문장.",
      answer: "kept",
      score: 60,
      corrections: [],
    });
    const text = JSON.stringify(buildBackup(false));
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      new File([text], "enlearn-backup.json", { type: "application/json" }),
    );
    await user.click(screen.getByRole("button", { name: /기존 기록을 지우고 대체/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /일부 저장에 실패했습니다/,
    );
    expect(screen.queryByText(/대체했습니다/)).not.toBeInTheDocument();
    confirmSpy.mockRestore();
    spy.mockRestore();
  });

  /*
   * D4-2(R6-3): 개수만 세면 "400건 합침"과 "2,000건 중 400건만 담김"이 같은 문구로
   * 나왔다. 잘린 개수와 형식이 맞지 않아 버린 개수를 화면에 적는다.
   */
  it("저장하지 못한 개수를 복원 문구에 담는다 (D4-2)", async () => {
    const bulk = Array.from({ length: MAX_RECORDS + 20 }, (_, i) => ({
      date: `2026-01-0${(i % 5) + 1}`,
      lane: "classic",
      en: `Bulk backup sentence ${i}.`,
      ko: `대량 백업 문장 ${i}.`,
      answer: `answer ${i}`,
      score: 50,
      corrections: [],
    }));
    const text = JSON.stringify({
      app: BACKUP_APP,
      version: 1,
      data: {
        log: [...bulk, { date: "2026-01-02", lane: "classic", score: 10 }], // 원문 없는 항목
        srs: [],
        seen: {},
        koreanCache: {},
      },
    });

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      new File([text], "enlearn-backup.json", { type: "application/json" }),
    );
    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain(`기록 ${MAX_RECORDS}개`);
    expect(status.textContent).toContain("20건은 저장소 상한으로 제외");
    expect(status.textContent).toContain("1건은 형식이 맞지 않아 제외");
    expect(loadLog()).toHaveLength(MAX_RECORDS);
  });
});

/*
 * R7-1: 합치기에서 기존 값(더 최근)이 이긴 항목은 저장소에 "키가 있다"는 사실로
 * 세지면 합친 것처럼 보인다. 오래된 백업을 합친 자리에
 * "저장소 상한으로 제외"까지 뜨면 사용자는 기록을 지워야 한다고 오해한다.
 */
describe("BackupCard — 합치기에서 밀린 항목 표시 (R7-1)", () => {
  it("더 최근 기록에 밀리면 0건을 알리고 '저장소 상한' 문구를 쓰지 않는다", async () => {
    logPractice({
      lane: "classic",
      en: "A sentence already newer than the backup.",
      ko: "백업보다 최근인 문장.",
      answer: "newest",
      score: 90,
      corrections: [],
    });
    // 지금 저장소와 같은 내용을 백업으로 합친다 → 적용되는 항목은 0건이다.
    const text = JSON.stringify(buildBackup(false));

    render(<BackupCard />);
    const user = userEvent.setup();
    await user.upload(
      screen.getByLabelText(/백업 가져오기/),
      new File([text], "enlearn-backup.json", { type: "application/json" }),
    );
    await user.click(screen.getByRole("button", { name: /지금 기록에 합치기/ }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("기록 0개");
    expect(status.textContent).toMatch(/적용되지 않음/);
    expect(status.textContent).not.toContain("저장소 상한");
    // 값은 실제로 그대로다(되돌릴 이유가 없다)
    expect(loadLog()).toHaveLength(1);
    expect(loadLog()[0].answer).toBe("newest");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_APP,
  settingsWarning,
  backupFilename,
  buildBackup,
  downloadBackup,
  parseBackup,
  restoreBackup,
} from "../backup";
import {
  addForReview,
  clearLog,
  clearSrs,
  dueCount,
  loadLog,
  logPractice,
  practiceStats,
  reviewItems,
  subscribeToPractice,
} from "../practice";
import { subscribeToProgress } from "../corpus";
import {
  cacheKorean,
  exportKoreanCache,
  exportSeen,
  importSeen,
  koreanCacheCount,
  markSeen,
} from "../corpus";
import { saveSettings } from "../settings";

function seed() {
  logPractice({
    lane: "classic",
    en: "Alice was beginning to get very tired.",
    ko: "앨리스는 지겨워지기 시작했습니다.",
    answer: "Alice begin to get tired.",
    score: 72,
    corrections: [{ original: "begin", better: "began" }],
  });
  logPractice({
    lane: "free",
    en: "I goed to school yesterday.",
    ko: null,
    answer: "I goed to school yesterday.",
    score: 55,
    corrections: [{ original: "goed", better: "went" }],
  });
  addForReview({
    id: "classic:seed",
    lane: "classic",
    en: "The rabbit hopped away quickly.",
    ko: "토끼가 잽싸게 달려갔다.",
  });
  markSeen("daily:11:abc");
  cacheKorean("classic:22:def", "캐시된 번역", ["rabbit"]);
  saveSettings({
    host: "https://api.example.com/v1",
    model: "test-model",
    apiKey: "sk-super-secret-value",
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("백업 내보내기", () => {
  it("기록·큐·본 기록·캐시와 개수를 담는다", () => {
    seed();
    const file = buildBackup();
    expect(file.app).toBe(BACKUP_APP);
    expect(file.counts).toEqual({ log: 2, srs: 2, seen: 1, koreanCache: 1 });
    expect(file.data.log).toHaveLength(2);
    expect(file.data.srs.map((x) => x.ko)).toContain("토끼가 잽싸게 달려갔다.");
    expect(file.data.seen["daily:11:abc"]).toBeTruthy();
    expect(file.data.koreanCache["classic:22:def"].ko).toBe("캐시된 번역");
    expect(file.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("⚠️ API 키는 절대 담지 않는다", () => {
    seed();
    const json = JSON.stringify(buildBackup());
    expect(json).not.toContain("sk-super-secret-value");
    expect(json).not.toContain("apiKey");
    expect(buildBackup().data.settings).toEqual({
      host: "https://api.example.com/v1",
      model: "test-model",
      endpoint: "https://api.example.com/v1/chat/completions",
    });
    // 설정을 빼달라고 하면 그것도 빠진다
    expect(buildBackup(false).data.settings).toBeUndefined();
  });

  it("파일 이름은 날짜를 담는다", () => {
    expect(backupFilename(new Date(2026, 10, 11))).toBe("enlearn-backup-2026-11-11.json");
  });

  it("다운로드가 안 되는 환경에서도 이름을 돌려준다", () => {
    seed();
    // jsdom은 Blob URL을 못 만든다 → data URL 폴백 경로가 타는지 확인한다
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const real = URL.createObjectURL;
    // jsdom 등 createObjectURL이 없는 환경
    // @ts-expect-error 테스트를 위해 지운다
    delete URL.createObjectURL;
    try {
      const result = downloadBackup();
      expect(result.name).toMatch(/^enlearn-backup-\d{4}-\d{2}-\d{2}\.json$/);
      expect(result.counts.log).toBe(2);
    } finally {
      URL.createObjectURL = real;
      click.mockRestore();
    }
  });

  it("브라우저에서는 링크를 눌러 다운로드를 시작한다", () => {
    seed();
    const clicks: string[] = [];
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => "blob:fake-url");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this.download);
      });

    const result = downloadBackup();
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([result.name]);
    expect(revoke).not.toHaveBeenCalled(); // 취소는 지연된다 (다운로드 시작 전 취소 방지)

    create.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  });
});

describe("백업 파일 검증", () => {
  it("JSON이 아니면 명확히 알려준다", () => {
    expect(() => parseBackup("이건 json 아님")).toThrow(/올바른 JSON/);
  });

  it("enlearn 백업이 아니면 거절한다", () => {
    expect(() => parseBackup(JSON.stringify({ app: "other", data: { log: [] } }))).toThrow(
      /enlearn 백업 파일이 아닙니다/,
    );
  });

  it("더 새로운 버전은 먼저 앱을 업데이트하라고 안내한다", () => {
    expect(() =>
      parseBackup(JSON.stringify({ app: BACKUP_APP, version: 99, data: { log: [], srs: [] } })),
    ).toThrow(/더 새로운 버전/);
  });

  it("데이터가 없거나 기록도 큐도 없으면 거절한다", () => {
    expect(() => parseBackup(JSON.stringify({ app: BACKUP_APP, version: 1 }))).toThrow(/data/);
    expect(() =>
      parseBackup(JSON.stringify({ app: BACKUP_APP, version: 1, data: { seen: {} } })),
    ).toThrow(/연습 기록/);
  });

  it("낡은 백업이라도 필요한 필드는 채워서 받아들인다", () => {
    const file = parseBackup(
      JSON.stringify({ app: BACKUP_APP, version: 1, data: { log: [], srs: [] } }),
    );
    expect(file.data.seen).toEqual({});
    expect(file.data.koreanCache).toEqual({});
    expect(file.data.settings).toBeUndefined();
    expect(file.counts).toEqual({ log: 0, srs: 0, seen: 0, koreanCache: 0 });
  });

  it("설정 일부만 있으면(키만 있는 등) 설정은 되돌리지 않는다", () => {
    const file = parseBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        data: { log: [], srs: [], settings: { apiKey: "sk-노출되면 안 됨" } },
      }),
    );
    expect(file.data.settings).toBeUndefined();
  });
});

describe("백업 복원", () => {
  it("합치기: 기존 기록을 지키면서 더해진다", () => {
    saveSettings({ host: "https://mine.example.com/v1", model: "mine", apiKey: "sk-super-secret-value" });
    logPractice({
      lane: "classic",
      en: "Existing sentence before restore.",
      ko: "복원 전 문장.",
      answer: "existing",
      score: 60,
      corrections: [],
    });
    const file = parseBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        data: {
          log: [
            {
              date: "2026-01-02",
              lane: "classic",
              en: "Restored sentence from backup.",
              ko: "복원된 문장.",
              answer: "restored",
              score: 91,
              corrections: [{ original: "goed", better: "went" }],
            },
          ],
          srs: [
            {
              id: "classic:r1",
              lane: "classic",
              en: "Restored queue sentence.",
              ko: "복원된 큐 문장.",
              stage: 2,
              due: "2099-01-01",
              lapses: 0,
              lastReviewed: "2026-01-02",
            },
          ],
          seen: { "classic:9:zzz": "2026-01-02T00:00:00.000Z" },
          koreanCache: { "classic:9:zzz": { ko: "복원된 번역", hints: ["abc"] } },
          settings: { host: "https://backup.example.com/v1", model: "backup-model" },
        },
      }),
    );

    // 기본값은 설정을 되돌리지 않는다 (다음 LLM 호출 대상 = 키가 가는 도메인)
    const result = restoreBackup(file);
    expect(result).toEqual({
      log: 1,
      srs: 1,
      seen: 1,
      koreanCache: 1,
      settingsRestored: false,
    });
    expect(loadLog()).toHaveLength(2);
    const restored = reviewItems().find((x) => x.id === "classic:r1");
    expect(restored?.stage).toBe(2);
    expect(restored?.due).toBe("2099-01-01");
    expect(exportSeen()["classic:9:zzz"]).toBeTruthy();
    const untouched = window.localStorage.getItem("enlearn.settings") ?? "";
    expect(untouched).toContain("mine.example.com");
    expect(untouched).not.toContain("backup.example.com");

    const again = restoreBackup(file, false, true);
    expect(again.settingsRestored).toBe(true);
    const saved = window.localStorage.getItem("enlearn.settings") ?? "";
    expect(saved).toContain("backup.example.com");
    // 백업에 키는 없으므로 지금의 키가 그대로 남는다
    expect(saved).toContain("sk-super-secret-value");
  });

  it("대체: 기존 기록·큐·캐시를 지우고 채운다", () => {
    seed();
    const file = parseBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        data: {
          log: [
            {
              date: "2026-01-05",
              lane: "daily",
              en: "The only sentence after replace.",
              ko: "대체 후 유일한 문장.",
              answer: "only",
              score: 77,
              corrections: [],
            },
          ],
          srs: [],
          seen: { "daily:3:only": "2026-01-05T00:00:00.000Z" },
          koreanCache: {},
        },
      }),
    );
    const before = loadLog().length;
    const result = restoreBackup(file, true);
    expect(before).toBe(2);
    expect(result.log).toBe(1);
    const log = loadLog();
    expect(log).toHaveLength(1);
    expect(log[0].en).toBe("The only sentence after replace.");
    expect(reviewItems()).toHaveLength(0);
    expect(exportKoreanCache()).toEqual({});
    expect(exportSeen()).toEqual({ "daily:3:only": "2026-01-05T00:00:00.000Z" });
  });

  it("빈 파일 내용으로 대체하면 모든 기록이 사라진다", () => {
    seed();
    const file = parseBackup(
      JSON.stringify({ app: BACKUP_APP, version: 1, data: { log: [], srs: [] } }),
    );
    restoreBackup(file, true);
    expect(loadLog()).toHaveLength(0);
    expect(reviewItems()).toHaveLength(0);
    expect(exportSeen()).toEqual({});
    expect(practiceStats().total).toBe(0);
    expect(koreanCacheCount()).toBe(0);
    expect(dueCount(new Date("2099-01-01T12:00:00"))).toBe(0);
  });
});

describe("round trip", () => {
  it("내보낸 파일을 그대로 다시 불러와도 내용이 유지된다", () => {
    seed();
    const file = parseBackup(JSON.stringify(buildBackup()));
    clearLog();
    clearSrs();
    importSeen({}, true);
    const result = restoreBackup(file, true);
    expect(result.log).toBe(2);
    expect(result.srs).toBe(2);
    expect(loadLog().map((r) => r.en).sort()).toEqual(
      [
        "Alice was beginning to get very tired.",
        "I goed to school yesterday.",
      ].sort(),
    );
    expect(reviewItems().map((x) => x.en).sort()).toEqual(
      [
        "Alice was beginning to get very tired.",
        "The rabbit hopped away quickly.",
      ].sort(),
    );
    // 통계도 되살아난다
    expect(practiceStats().total).toBe(2);
    expect(practiceStats().topMistakes.map((m) => m.original)).toContain("goed");
    expect(practiceStats().topMistakes.map((m) => m.original)).toContain("begin");
  });
});

describe("백업된 연결 설정 검증 (3-1)", () => {
  const withSettings = (settings: unknown) =>
    JSON.stringify({ app: BACKUP_APP, version: 1, data: { log: [], srs: [], settings } });

  it("검증되지 않는 host는 조용히 버린다", () => {
    for (const host of ["ftp://api.example.com/v1", "not a // url", "", "  ", {}]) {
      expect(parseBackup(withSettings({ host, model: "m" })).data.settings).toBeUndefined();
    }
  });

  it("model이 없어도 설정을 되돌리지 않는다", () => {
    expect(
      parseBackup(withSettings({ host: "https://api.example.com/v1" })).data.settings,
    ).toBeUndefined();
  });

  it("staging된 host는 정규화된 endpoint로 보관하고 http는 경고한다", () => {
    const file = parseBackup(
      withSettings({ host: "api.example.com/v1/", model: "gpt-4o-mini" }),
    );
    expect(file.data.settings?.endpoint).toBe("https://api.example.com/v1/chat/completions");

    const insecure = parseBackup(
      withSettings({ host: "http://collector.example.net/v1", model: "evil" }),
    );
    expect(insecure.data.settings?.endpoint).toBe(
      "http://collector.example.net/v1/chat/completions",
    );
    expect(settingsWarning(insecure.data.settings)).toMatch(/평문/);
    // localhost http는 정상 사용이라 경고하지 않는다
    expect(
      settingsWarning({ host: "http://localhost:11434/v1", model: "llama", endpoint: "x" }),
    ).toBeNull();
  });

  it("확인 없이 복원해도 연결 설정은 바뀌지 않는다", () => {
    saveSettings({ host: "https://safe.example.com/v1", model: "mine", apiKey: "sk-keep" });
    const file = parseBackup(
      withSettings({ host: "http://collector.example.net/v1", model: "evil" }),
    );
    restoreBackup(file, false, false);
    expect(window.localStorage.getItem("enlearn.settings")).toContain("safe.example.com");
    expect(window.localStorage.getItem("enlearn.settings")).not.toContain("collector");
  });
});

describe("백업 파일 손상 대응", () => {
  it("counts가 이상한 값이라도 숫자로 다뤄 크래시하지 않는다", () => {
    const file = parseBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        counts: { log: { nested: 1 }, srs: "한 Thousand", seen: null, koreanCache: -3 },
        data: { log: [], srs: [] },
      }),
    );
    expect(file.counts).toEqual({ log: 0, srs: 0, seen: 0, koreanCache: 0 });
  });

  it("counts는 실제 내용에서 다시 센다 (파일 값과 달라도)", () => {
    const file = parseBackup(
      JSON.stringify({
        app: BACKUP_APP,
        version: 1,
        counts: { log: 9_999, srs: 0, seen: 0, koreanCache: 0 },
        data: {
          log: [
            { date: "2026-01-02", lane: "classic", en: "One sentence.", answer: "a", score: 10 },
            { date: "2026-01-03", lane: "classic", en: "Two sentence.", answer: "b", score: 20 },
          ],
          srs: [],
          seen: { "classic:1:a": "x" },
          koreanCache: { "classic:1:a": { ko: "번역", hints: [] } },
        },
      }),
    );
    expect(file.counts).toEqual({ log: 2, srs: 0, seen: 1, koreanCache: 1 });
  });

  it("version 0·음수·문자열 '0'은 거부한다", () => {
    for (const version of [0, -5, "0", "abc"]) {
      expect(() =>
        parseBackup(JSON.stringify({ app: BACKUP_APP, version, data: { log: [], srs: [] } })),
      ).toThrow(/백업 버전/);
    }
  });
});

describe("restoreBackup — 알림 묶음 (리뷰 3-10)", () => {
  it("저장소마다 알림이 한 번만 나간다", () => {
    const file = buildBackup(false);
    file.data.log = [
      {
        id: "classic:b1",
        date: "2026-01-05",
        ts: 1,
        lane: "classic",
        en: "Restored one.",
        ko: "복원된 한 문장.",
        answer: "one",
        score: 55,
        corrections: [],
      },
      {
        id: "classic:b2",
        date: "2026-01-06",
        ts: 2,
        lane: "classic",
        en: "Restored two.",
        ko: "복원된 두 문장.",
        answer: "two",
        score: 65,
        corrections: [],
      },
    ];
    file.data.srs = [
      {
        id: "classic:b1",
        lane: "classic",
        en: "Restored one.",
        ko: "복원된 한 문장.",
        stage: 1,
        due: "2026-02-01",
        lapses: 0,
        lastReviewed: null,
      },
    ];
    file.data.seen = { "classic:1:aaa": "2026-01-05T00:00:00.000Z" };
    file.data.koreanCache = {
      "classic:1:aaa": { ko: "복원된 한 문장.", hints: ["one"] },
    };

    let practiceEvents = 0;
    let progressEvents = 0;
    const offPractice = subscribeToPractice(() => {
      practiceEvents += 1;
    });
    const offProgress = subscribeToProgress(() => {
      progressEvents += 1;
    });

    restoreBackup(file, false, false);
    offPractice();
    offProgress();

    expect(practiceEvents).toBe(1);
    expect(progressEvents).toBe(1);
    expect(practiceStats().total).toBe(2);
    expect(koreanCacheCount()).toBe(1);
  });
});

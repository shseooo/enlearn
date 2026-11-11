import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKUP_APP,
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
} from "../practice";
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

    const result = restoreBackup(file);
    expect(result).toEqual({
      log: 1,
      srs: 1,
      seen: 1,
      koreanCache: 1,
      settingsRestored: true,
    });
    expect(loadLog()).toHaveLength(2);
    const restored = reviewItems().find((x) => x.id === "classic:r1");
    expect(restored?.stage).toBe(2);
    expect(restored?.due).toBe("2099-01-01");
    expect(exportSeen()["classic:9:zzz"]).toBeTruthy();
    expect(window.localStorage.getItem("enlearn.settings")).toContain("backup.example.com");
    expect(window.localStorage.getItem("enlearn.settings")).not.toContain("sk-");
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

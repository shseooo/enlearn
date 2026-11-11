/**
 * 연습 기록 백업/복원.
 *
 * 이 앱은 서버가 없어서 모든 게 브라우저 localStorage에 있다. 브라우저 초기화·
 * 기기 교체를 하면 연속 연습일과 복습 큐가 그대로 사라지므로, JSON 한 장으로
 * 옮길 수 있게 한다.
 *
 * ⚠️ API 키는 어떤 경우에도 백업에 담지 않는다. 호스트·모델 이름만 넣는다.
 */
import { exportLog, importLog, importSrs, reviewItems } from "./practice";
import {
  clearKoreanCache,
  exportKoreanCache,
  exportSeen,
  importKoreanCache,
  importSeen,
} from "./corpus";
import { loadSettings, saveSettings } from "./settings";
import { localDateString } from "./corpus";
import type { PracticeRecord, SrsItem } from "./practice";
import type { CachedKorean } from "./corpus";

export const BACKUP_APP = "enlearn";
export const BACKUP_VERSION = 1;

export interface BackupCounts {
  log: number;
  srs: number;
  seen: number;
  koreanCache: number;
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  counts: BackupCounts;
  data: {
    log: PracticeRecord[];
    srs: SrsItem[];
    seen: Record<string, string>;
    koreanCache: Record<string, CachedKorean>;
    /** API 키는 넣지 않는다. 연결 설정의 이름만 보관한다. */
    settings?: { host: string; model: string };
  };
}

export function backupFilename(now = new Date()): string {
  return `enlearn-backup-${localDateString(now)}.json`;
}

export function buildBackup(includeSettings = true): BackupFile {
  const log = exportLog();
  const srs = reviewItems();
  const seen = exportSeen();
  const koreanCache = exportKoreanCache();
  const settings = loadSettings();
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      log: log.length,
      srs: srs.length,
      seen: Object.keys(seen).length,
      koreanCache: Object.keys(koreanCache).length,
    },
    data: {
      log,
      srs,
      seen,
      koreanCache,
      ...(includeSettings
        ? { settings: { host: settings.host, model: settings.model } }
        : {}),
    },
  };
}

/** 백업 JSON을 검증한다. 형식이 다르면 한국어 오류 메시지를 던진다. */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("파일이 올바른 JSON이 아닙니다.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("백업 파일 형식이 올바르지 않습니다.");
  }
  const o = parsed as Record<string, unknown>;
  if (o.app !== BACKUP_APP) {
    throw new Error("enlearn 백업 파일이 아닙니다.");
  }
  const version = typeof o.version === "number" ? o.version : Number(o.version);
  if (!Number.isFinite(version) || version > BACKUP_VERSION) {
    throw new Error(
      `더 새로운 버전(${String(o.version)})의 백업입니다. 앱을 업데이트한 뒤 다시 시도하세요.`,
    );
  }
  const data = o.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("백업 안에 데이터(data)가 없습니다.");
  }
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.log) && !Array.isArray(d.srs)) {
    throw new Error("백업에 연습 기록(log)도 복습 큐(srs)도 없습니다.");
  }
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    counts:
      typeof o.counts === "object" && o.counts !== null
        ? (o.counts as BackupCounts)
        : { log: 0, srs: 0, seen: 0, koreanCache: 0 },
    data: {
      log: Array.isArray(d.log) ? (d.log as PracticeRecord[]) : [],
      srs: Array.isArray(d.srs) ? (d.srs as SrsItem[]) : [],
      seen:
        typeof d.seen === "object" && d.seen !== null && !Array.isArray(d.seen)
          ? (d.seen as Record<string, string>)
          : {},
      koreanCache:
        typeof d.koreanCache === "object" &&
        d.koreanCache !== null &&
        !Array.isArray(d.koreanCache)
          ? (d.koreanCache as Record<string, CachedKorean>)
          : {},
      settings:
        typeof d.settings === "object" &&
        d.settings !== null &&
        !Array.isArray(d.settings)
          ? ((d.settings as Record<string, unknown>).host &&
              (d.settings as Record<string, unknown>).model
              ? {
                  host: String((d.settings as Record<string, unknown>).host),
                  model: String((d.settings as Record<string, unknown>).model),
                }
              : undefined)
          : undefined,
    },
  };
}

export interface RestoreResult {
  log: number;
  srs: number;
  seen: number;
  koreanCache: number;
  settingsRestored: boolean;
}

/** 백업 내용을 저장소에 반영한다. replace=true면 기존 기록을 지우고 채운다. */
export function restoreBackup(file: BackupFile, replace = false): RestoreResult {
  if (replace) {
    // import*(replace=true)가 빈 목록으로도 저장소를 비운다
    clearKoreanCache();
  }
  const result: RestoreResult = {
    log: importLog(file.data.log, replace),
    srs: importSrs(file.data.srs, replace),
    seen: importSeen(file.data.seen, replace),
    koreanCache: importKoreanCache(file.data.koreanCache, replace),
    settingsRestored: false,
  };
  if (file.data.settings) {
    const current = loadSettings();
    saveSettings({
      ...current,
      host: file.data.settings.host,
      model: file.data.settings.model,
    });
    result.settingsRestored = true;
  }
  return result;
}

/** 브라우저에서 JSON 파일로 내려받는다. (파일 이름에 날짜를 넣는다) */
export function downloadBackup(
  includeSettings = true,
): { name: string; counts: BackupCounts } {
  const file = buildBackup(includeSettings);
  const name = backupFilename();
  const json = JSON.stringify(file, null, 2);
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return { name, counts: file.counts };
  }

  let url: string;
  try {
    url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  } catch {
    // Blob URL을 만들 수 없는 환경에서는 data URL로 내린다 (파일 다운로드는 같다)
    url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 취소하면 일부 브라우저에서 다운로드가 시작되지 않는다
  if (url.startsWith("blob:")) setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name, counts: file.counts };
}

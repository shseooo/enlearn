/**
 * 연습 기록 백업/복원.
 *
 * 이 앱은 서버가 없어서 모든 게 브라우저 localStorage에 있다. 브라우저 초기화·
 * 기기 교체를 하면 연속 연습일과 복습 큐가 그대로 사라지므로, JSON 한 장으로
 * 옮길 수 있게 한다.
 *
 * ⚠️ API 키는 어떤 경우에도 백업에 담지 않는다. 호스트·모델 이름만 넣는다.
 */
import {
  batchPractice,
  exportLog,
  importLog,
  importSrs,
  reviewItems,
} from "./practice";
import {
  batchProgress,
  clearKoreanCache,
  exportKoreanCache,
  exportSeen,
  importKoreanCache,
  importSeen,
} from "./corpus";
import { loadSettings, saveSettings } from "./settings";
import { checkHost, hostWarning } from "./llm";
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

/**
 * 파싱 직후의 백업. 항목은 아직 검증되지 않은 raw JSON 값이다(리뷰 1-19).
 * 실제 검증은 restoreBackup이 importLog/importSrs/importSeen/importKoreanCache의
 * sanitizer를 거칠 때 일어난다. 그래서 이 타입을 믿고 항목에 손을 대면 안 된다.
 */
export interface RawBackupData {
  log: unknown[];
  srs: unknown[];
  seen: Record<string, unknown>;
  koreanCache: Record<string, unknown>;
  /** API 키는 넣지 않는다. 연결 설정의 이름만 보관한다. */
  settings?: { host: string; model: string; endpoint: string };
}

export interface RawBackupFile {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  counts: BackupCounts;
  data: RawBackupData;
}

/** 이 앱이 저장소에서 만들어낸 "검증된" 백업 (내보내기용) */
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
    settings?: { host: string; model: string; endpoint: string };
  };
}

/**
 * 백업 항목 수 상한(리뷰 1-16). 실제 저장소 상한(기록 400 · seen 20,000 ·
 * 번역 캐시 4,000)보다 훨씬 넉넉하게 잡아, 정상 백업은 절대 걸리지 않게 한다.
 * 수십만 항목을 파싱·병합하면 메인 스레드가 멈춘다.
 */
export const MAX_BACKUP_ITEMS = 50_000;

export function backupFilename(now = new Date()): string {
  return `enlearn-backup-${localDateString(now)}.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 데이터에서 개수를 세는다. 파일에 적힌 counts는 믿지 않는다(3-4). */
function countsOf(
  data: Pick<RawBackupData, "log" | "srs" | "seen" | "koreanCache">,
): BackupCounts {
  return {
    log: data.log.length,
    srs: data.srs.length,
    seen: Object.keys(data.seen).length,
    koreanCache: Object.keys(data.koreanCache).length,
  };
}

/** 연결 설정 백업에 쓸 수 있는 형태인지 검증한다. 통과 실패 = 설정 없음. */
function safeSettings(value: unknown): BackupFile["data"]["settings"] {
  if (!isRecord(value)) return undefined;
  const host = typeof value.host === "string" ? value.host.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!host || !model) return undefined;
  const check = checkHost(host);
  // 검증되지 않은 host를 저장하면 다음 LLM 호출의 API 키가 제3자 도메인으로 간다
  if (!check.ok) return undefined;
  return { host, model, endpoint: check.endpoint };
}

/** http 원격 호스트 경고 (백업 미리보기·설정 화면에서 같은 문구를 쓴다) */
export function settingsWarning(settings?: BackupFile["data"]["settings"]): string | null {
  if (!settings) return null;
  return hostWarning(settings.host);
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
    data: {
      log,
      srs,
      seen,
      koreanCache,
      ...(includeSettings ? { settings: safeSettings(settings) } : {}),
    },
    counts: countsOf({ log, srs, seen, koreanCache }),
  };
}

/** 백업 JSON을 검증한다. 형식이 다르면 한국어 오류 메시지를 던진다. */
export function parseBackup(text: string): RawBackupFile {
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
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("백업 버전 정보가 없습니다. 이 앱에서 내보낸 파일인지 확인하세요.");
  }
  if (version > BACKUP_VERSION) {
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
  const payload: RawBackupData = {
    log: Array.isArray(d.log) ? d.log : [],
    srs: Array.isArray(d.srs) ? d.srs : [],
    seen:
      typeof d.seen === "object" && d.seen !== null && !Array.isArray(d.seen)
        ? (d.seen as Record<string, unknown>)
        : {},
    koreanCache:
      typeof d.koreanCache === "object" &&
      d.koreanCache !== null &&
      !Array.isArray(d.koreanCache)
        ? (d.koreanCache as Record<string, unknown>)
        : {},
    settings: safeSettings(d.settings),
  };
  // 항목 수가 비정상적으로 많으면 복원 시도 자체가 탭을 멈춘다(리뷰 1-16).
  const counts: Array<[string, number]> = [
    ["연습 기록", payload.log.length],
    ["복습 큐", payload.srs.length],
    ["받은 문장 기록", Object.keys(payload.seen).length],
    ["번역 캐시", Object.keys(payload.koreanCache).length],
  ];
  for (const [label, count] of counts) {
    if (count > MAX_BACKUP_ITEMS) {
      throw new Error(
        `백업의 ${label} 항목이 너무 많습니다(${count}개, 최대 ${MAX_BACKUP_ITEMS}개).`,
      );
    }
  }
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: typeof o.exportedAt === "string" ? o.exportedAt : "",
    // 파일에 적힌 counts는 위조·손상될 수 있으므로 실제 내용으로 다시 센다
    counts: countsOf(payload),
    data: payload,
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
/**
 * 백업 내용을 저장소에 반영한다.
 * replace=true면 기존 기록을 지우고 채운다.
 * ⚠️ restoreSettings는 기본 false — 연결 설정을 되돌리면 **다음 LLM 호출의 대상**이
 * 바뀌고 API 키가 그 도메인으로 간다. 별도 확인을 거쳐서만 반영한다.
 */
export function restoreBackup(
  file: RawBackupFile,
  replace = false,
  restoreSettings = false,
): RestoreResult {
  // 여러 저장소를 한꺼번에 바꾼다. 알림이 저장소마다 여러 번 나면
  // 화면이 몇 번씩 다시 그려진다(리뷰 3-10).
  const result: RestoreResult = batchProgress(() =>
    batchPractice(() => {
      if (replace) {
        // import*(replace=true)가 빈 목록으로도 저장소를 비운다
        clearKoreanCache();
      }
      return {
        log: importLog(file.data.log, replace),
        srs: importSrs(file.data.srs, replace),
        seen: importSeen(file.data.seen, replace),
        koreanCache: importKoreanCache(file.data.koreanCache, replace),
        settingsRestored: false,
      };
    }),
  );
  if (restoreSettings && file.data.settings) {
    const current = loadSettings();
    // API 키는 백업에 없으므로 지금의 키를 그대로 둔다
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

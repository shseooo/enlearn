import type { LLMSettings } from "./types";
import { safeSetItem } from "./storage";

const STORAGE_KEY = "enlearn.settings";
const CHANGE_EVENT = "enlearn:settings-changed";

export const DEFAULT_SETTINGS: LLMSettings = {
  host: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  apiKey: "",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseRaw(raw: string | null): LLMSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_SETTINGS;
    return {
      host: typeof parsed.host === "string" ? parsed.host : DEFAULT_SETTINGS.host,
      model:
        typeof parsed.model === "string" ? parsed.model : DEFAULT_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** localStorage에서 설정을 읽어온다. (없거나 깨졌으면 기본값) */
export function loadSettings(): LLMSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  return parseRaw(window.localStorage.getItem(STORAGE_KEY));
}

/** 설정을 localStorage에 저장하고, 같은 탭의 구독자들에게 변경을 알린다. */
export function saveSettings(settings: LLMSettings): void {
  if (typeof window === "undefined") return;
  // 용량 초과 등 저장 실패가 설정 화면을 멈추게 하지는 않는다
  safeSetItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// ---------------------------------------------------------------------------
// useSyncExternalStore용 외부 스토어 (설정 화면 저장 시 다른 탭도 즉시 반영)
// ---------------------------------------------------------------------------

let cacheRaw: string | null = null;
let cacheValue: LLMSettings | null = null;

export function subscribeToSettings(callback: () => void): () => void {
  window.addEventListener("storage", callback); // 다른 탭 변경
  window.addEventListener(CHANGE_EVENT, callback); // 같은 탭 변경
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

/** 스냅샷은 값이 바뀔 때만 새 참조를 반환해야 한다. (무한 재렌더 방지) */
export function getSettingsSnapshot(): LLMSettings {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== cacheRaw || cacheValue === null) {
    cacheRaw = raw;
    cacheValue = parseRaw(raw);
  }
  return cacheValue;
}

/** SSR/하이드레이션 시 사용: 항상 참조가 안정된 기본값 */
export function getSettingsServerSnapshot(): LLMSettings {
  return DEFAULT_SETTINGS;
}

/**
 * LLM을 호출할 수 있는 상태인지. API 키는 선택적이다:
 * Ollama 같은 로컬/게이트웨이 호스트는 키 없이 OpenAI 호환 API를 제공한다.
 */
export function isSettingsComplete(s: LLMSettings): boolean {
  return Boolean(s.host.trim() && s.model.trim());
}

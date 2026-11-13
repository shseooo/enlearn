"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import {
  downloadBackup,
  parseBackup,
  restoreBackup,
  settingsWarning,
  type BackupSection,
  type RawBackupFile,
} from "@/lib/backup";
import {
  getPracticeServerSnapshot,
  getPracticeSnapshot,
  subscribeToPractice,
} from "@/lib/practice";

/**
 * 연습 기록 백업/복원 카드.
 * 서버가 없는 앱이라 브라우저가 초기화되면 연속 연습일·복습 큐가 사라진다.
 * API 키는 어떤 백업에도 들어가지 않는다(호스트·모델 이름만 보관).
 */

/**
 * 읽어보기 전에 거르는 파일 크기 상한(리뷰 1-16). 실제 백업은 수백 KB이고,
 * 수백 MB JSON을 file.text()로 읽으면 메인 스레드가 멈춘다.
 */
/** 읽어보기 전에 거르는 파일 크기 상한(리뷰 1-16). 실제 백업은 수백 KB이고,
 * 수백 MB JSON을 file.text()로 읽으면 메인 스레드가 멈춘다.
 */
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

/** D8-1: 저장소를 사람 이름으로 적는다(없는 섹션을 알려주는 문구에 쓴다). */
const SECTION_LABELS: Record<BackupSection, string> = {
  log: "연습 기록",
  srs: "복습 큐",
  seen: "받은 문장 기록",
  koreanCache: "번역 캐시",
};

function sectionCount(name: string, present: boolean, count: number): string {
  return present ? `${name} ${count}개` : `${name} 없음`;
}

export default function BackupCard() {
  const snapshot = useSyncExternalStore(
    subscribeToPractice,
    getPracticeSnapshot,
    getPracticeServerSnapshot,
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<RawBackupFile | null>(null);
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 연결 설정 되돌리기는 다음 LLM 호출 대상(= API 키가 가는 도메인)을 바꾼다.
  // 그래서 기본은 꺼두고, 사용자가 직접 켜되 목표 주소를 화면에서 확인하게 한다.
  const [wantSettings, setWantSettings] = useState(false);

  function handleExport() {
    try {
      const { name, counts } = downloadBackup();
      setMessage(
        `${name} 저장했습니다 — 기록 ${counts.log}개 · 복습 큐 ${counts.srs}개`,
      );
      setError(null);
    } catch (e) {
      setMessage(null);
      setError(e instanceof Error ? e.message : "다운로드에 실패했습니다.");
    }
  }

  async function handleFile(file: File) {
    setLoaded(null);
    setError(null);
    setMessage(null);
    if (file.size > MAX_BACKUP_BYTES) {
      setError(
        `백업 파일이 너무 큽니다(${(file.size / 1024 / 1024).toFixed(1)}MB). ` +
          `최대 ${MAX_BACKUP_BYTES / 1024 / 1024}MB까지 읽을 수 있습니다.`,
      );
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    try {
      const text = await file.text();
      const parsed = parseBackup(text);
      setLoaded(parsed);
      setFileName(file.name);
      setWantSettings(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "백업을 읽을 수 없습니다.");
    }
  }

  function handleRestore(replace: boolean) {
    if (!loaded) return;
    const result = restoreBackup(loaded, replace, wantSettings);
    setLoaded(null);
    if (fileRef.current) fileRef.current.value = "";
    if (result.writeFailed) {
      // 저장이 실패하면 위의 개수는 바뀌지 않은 이전 값이다.
      // "기존 기록을 대체했습니다"를 그대로 보여주면 사용자는 없는 결과를 믿는다(리뷰 2-4).
      setMessage(null);
      setError(
        "일부 저장에 실패했습니다 — 용량을 정리한 뒤 다시 시도하세요. 올려준 백업 파일은 그대로지만, " +
          "저장소는 일부만 바뀔 수 있습니다.",
      );
      return;
    }
    // D4-2: "기록 400개"가 "400개만 들어가고 나머지는 버려졌다"와 구분되지 않았다.
    const sum = (counts: typeof result.trimmed) =>
      counts.log + counts.srs + counts.seen + counts.koreanCache;
    const trimmed = sum(result.trimmed);
    const rejected = sum(result.rejected);
    // R7-1: 상한으로 잘린 것과 합치기에서 밀린 것을 같은 문구로 보여주면
    // 사용자는 "저장소 상한" 때문에 기록을 지워야 한다고 오해한다.
    const notApplied = sum(result.merged);
    // D8-1: 파일에 없어서 손대지 않은 저장소는 "0개"가 아니라 "그대로 남음"이다.
    const keptAsIs = result.omitted.map((name) => SECTION_LABELS[name]).join("·");
    const countOf = (name: BackupSection, text: string, value: number) =>
      result.omitted.includes(name) ? null : `${text} ${value}개`;
    setMessage(
      [
        countOf("log", "기록", result.log),
        countOf("srs", "복습 큐", result.srs),
        countOf("seen", "받은 문장", result.seen),
        countOf("koreanCache", "번역 캐시", result.koreanCache),
      result.settingsRestored ? "연결 설정" : null,
        keptAsIs ? `이 백업에 없는 섹션: ${keptAsIs} (그대로 남음)` : null,
        trimmed > 0 ? `${trimmed}건은 저장소 상한으로 제외` : null,
        // R8-6: "더 최근 기록이 있어"는 번역 캐시에는 맞지 않는다(kocache는 시각 정보가
        // 없어 기존 값 우선 — D2-1). 네 저장소에 모두 참인 말로 쓴다.
        notApplied > 0 ? `${notApplied}건은 이미 저장된 값이 있어 적용되지 않음` : null,
        rejected > 0 ? `${rejected}건은 형식이 맞지 않아 제외` : null,
      ]
        .filter(Boolean)
        .join(" · ") + (replace ? " — 기존 기록을 대체했습니다" : " 을(를) 합쳤습니다"),
    );
    setError(null);
  }

  /**
   * D1-1/R8-2: 실제로 지우는 저장소를 모두 적고, D8-1: 파일에 없어서 그대로 남는
   * 저장소도 함께 알려준다. "0개로 대체"와 "그대로 남음"은 사용자가 내리는 판단이 다르다.
   */
  function confirmReplace(): boolean {
    if (!loaded) return false;
    const absent = (Object.keys(loaded.present) as BackupSection[]).filter(
      (name) => !loaded.present[name],
    );
    return window.confirm(
      "기존 연습 기록·복습 큐·받은 문장 기록·한국어 번역 캐시를 지우고 " +
        "백업 내용으로 대체합니다. " +
        (absent.length > 0
          ? `이 백업에 없는 섹션(${absent.map((n) => SECTION_LABELS[n]).join("·")})은 그대로 남습니다. `
          : "") +
        "되돌릴 수 없습니다 — 먼저 백업을 내보내세요. 계속할까요?",
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-base font-bold text-slate-800">백업 · 복구</h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        연습 기록과 복습 큐는 이 브라우저에만 있습니다. 다른 기기·브라우저로
        옮기려면 내보내기를, 되돌리려면 가져오기를 씁니다.{" "}
        <strong className="font-semibold text-slate-700">API 키는 백업에 들어가지 않습니다.</strong>
      </p>
      <p className="mb-3 text-xs leading-relaxed text-slate-500">
        {/* D8-2: 한 문장으로 네 저장소를 같이 설명하면 번역 캐시에 거짓말이 된다
            (번역은 시각 비교 없이 기존 값 우선 — D2-1). 저장은 바꾸지 않고 말만 나눈다. */}
        합치기는 연습 기록·복습 큐·받은 문장에서 더 최근 기록을 남깁니다. 이미 번역된
        문장의 번역은 백업으로 바뀌지 않습니다. 백업 내용 그대로 되돌리려면{" "}
        『기존 기록을 지우고 대체』를 사용하세요.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleExport}
          className="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-900"
        >
          ⬇️ 백업 내보내기 ({snapshot.total}개 기록)
        </button>
        <label className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50">
          ⬆️ 백업 가져오기
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
        </label>
      </div>

      {loaded && (
        <div className="mb-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
          <p className="mb-2 font-semibold text-slate-700">
            {fileName} —{" "}
            {loaded.exportedAt
              ? `${loaded.exportedAt.slice(0, 10)}에 내보낸 백업`
              : "날짜 없는 백업"}
          </p>
          <p className="mb-3">
            {sectionCount("기록", loaded.present.log, loaded.counts.log)} ·{" "}
            {sectionCount("복습 큐", loaded.present.srs, loaded.counts.srs)} ·{" "}
            {sectionCount("받은 문장", loaded.present.seen, loaded.counts.seen)} ·{" "}
            {sectionCount(
              "번역 캐시",
              loaded.present.koreanCache,
              loaded.counts.koreanCache,
            )}
          </p>
          {loaded.data.settings && (
            <label className="mb-3 flex items-start gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={wantSettings}
                onChange={(e) => setWantSettings(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                연결 설정도 되돌리기 —{" "}
                <code className="rounded bg-slate-200 px-1 py-0.5 text-[11px]">
                  {loaded.data.settings.endpoint}
                </code>
                <br />
                켜면 이후 LLM 요청이 이 주소로 가고{" "}
                <strong className="font-semibold">현재 API 키가 그 도메인으로 전송</strong>됩니다.
                처음 보는 파일이라면 끄세요.
                {settingsWarning(loaded.data.settings) && (
                  <span className="mt-1 block font-semibold text-rose-600">
                    ⚠️ {settingsWarning(loaded.data.settings)}
                  </span>
                )}
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => handleRestore(false)}
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700"
            >
              지금 기록에 합치기
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirmReplace()) {
                  handleRestore(true);
                }
              }}
              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
            >
              기존 기록을 지우고 대체
            </button>
            <button
              type="button"
              onClick={() => {
                setLoaded(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className="text-xs text-slate-500">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
    </div>
  );
}

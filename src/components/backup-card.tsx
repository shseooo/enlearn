"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import {
  downloadBackup,
  parseBackup,
  restoreBackup,
  settingsWarning,
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
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

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
        "일부 저장에 실패했습니다 — 용량을 정리한 뒤 다시 시도하세요. 백업 내용은 그대로입니다.",
      );
      return;
    }
    setMessage(
      [
        `기록 ${result.log}개`,
        `복습 큐 ${result.srs}개`,
        `받은 문장 ${result.seen}개`,
        `번역 캐시 ${result.koreanCache}개`,
        result.settingsRestored ? "연결 설정" : null,
      ]
        .filter(Boolean)
        .join(" · ") + (replace ? " — 기존 기록을 대체했습니다" : " 을(를) 합쳤습니다"),
    );
    setError(null);
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="mb-1 text-base font-bold text-slate-800">백업 · 복구</h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        연습 기록과 복습 큐는 이 브라우저에만 있습니다. 다른 기기·브라우저로
        옮기려면 내보내기를, 되돌리려면 가져오기를 씁니다.{" "}
        <strong className="font-semibold text-slate-700">API 키는 백업에 들어가지 않습니다.</strong>
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
            기록 {loaded.counts.log}개 · 복습 큐 {loaded.counts.srs}개 · 받은 문장{" "}
            {loaded.counts.seen}개 · 번역 캐시 {loaded.counts.koreanCache}개
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
                if (
                  window.confirm(
                    "기존 연습 기록·복습 큐·번역 캐시를 지우고 백업 내용으로 대체합니다. 계속할까요?",
                  )
                ) {
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

"use client";

import { useEffect, useRef, useState } from "react";
import type { LLMSettings } from "@/lib/types";
import { checkHost, testConnection } from "@/lib/llm";
import { useCancellable } from "@/lib/use-cancellable";
import BackupCard from "./backup-card";
import ProgressReset from "./progress-reset";

interface SettingsTabProps {
  settings: LLMSettings;
  /** 저장은 store(saveSettings) 한 곳에서만 일어난다. 화면은 의뢰만 한다. */
  onSaved: (settings: LLMSettings) => void;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

/** ⚙️ 설정: LLM host/model/apiKey (localStorage 저장) */
export default function SettingsTab({ settings, onSaved }: SettingsTabProps) {
  /**
   * 저장된 값(props)과 다른 '아직 저장하지 않은 편집'만 따로 담는다.
   * - 편집이 없으면 다른 탭/다른 화면의 저장값이 그대로 반영된다.
   * - 편집 중이면 외부 저장이 입력창을 덮어쓰지 않는다.
   */
  const [edited, setEdited] = useState<LLMSettings | null>(null);
  const draft = edited ?? settings;
  const dirty = edited !== null;
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const { begin, cancel } = useCancellable();
  const testSeq = useRef(0);

  const host = draft.host;
  const model = draft.model;
  const apiKey = draft.apiKey;

  const hostCheck = checkHost(host);
  const canSave = hostCheck.ok && Boolean(model.trim());

  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  function handleSave() {
    if (!canSave) return;
    const next = {
      host: host.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
    };
    // 저장은 onSaved(store) 한 번만. localStorage를 두 번 쓰면 이벤트·재렌더도 두 번 된다.
    onSaved(next);
    setEdited(null);
    setSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSaved(false), 2000);
  }

  /**
   * 연결 테스트도 취소할 수 있게 한다. 다른 탭과 달리 여기만 취소 수단이 없어
   * 프로바이더가 멈추면 120초를 그대로 서 있어야 했다(리뷰 3-10).
   */
  async function handleTest() {
    const seq = ++testSeq.current;
    const stale = () => seq !== testSeq.current;
    const { signal } = begin();
    setTest({ status: "testing" });
    try {
      const reply = await testConnection(
        {
          host: host.trim(),
          model: model.trim(),
          apiKey: apiKey.trim(),
        },
        { signal },
      );
      if (stale() || signal.aborted) return;
      setTest({ status: "ok", message: `연결 성공! LLM 응답: ${reply}` });
    } catch (e) {
      if (stale() || signal.aborted) return; // 취소는 오류가 아니다
      setTest({
        status: "error",
        message: e instanceof Error ? e.message : "연결 테스트에 실패했습니다.",
      });
    } finally {
      // 취소하면 "테스트 중…"에 갇히지 않고 빠져나온다
      if (!stale()) {
        setTest((t) => (t.status === "testing" ? { status: "idle" } : t));
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 text-base font-bold text-slate-800">
          LLM 설정
        </h2>
        <p className="mb-5 text-xs leading-relaxed text-slate-500">
          OpenAI 호환 API(
          <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">
            /chat/completions
          </code>
          )를 사용합니다. 설정은 이 브라우저의{" "}
          <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">
            localStorage
          </code>
          에만 저장되며 서버로 전송되지 않습니다.
        </p>

        <div className="space-y-4">
          <div>
            <label
              htmlFor="llm-host"
              className="mb-1.5 block text-sm font-semibold text-slate-700"
            >
              Host
            </label>
            <input
              id="llm-host"
              type="url"
              value={host}
              onChange={(e) => setEdited({ ...draft, host: e.target.value })}
              placeholder="https://api.openai.com/v1"
              aria-invalid={!hostCheck.ok}
              aria-describedby="llm-host-help"
              className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
            <p
              id="llm-host-help"
              className={`mt-1 text-xs ${hostCheck.ok ? "text-slate-400" : "text-rose-600"}`}
            >
              {hostCheck.ok
                ? `요청 대상: ${hostCheck.endpoint}`
                : hostCheck.message}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              예: https://api.openai.com/v1 · http://localhost:11434/v1 ·
              https://openrouter.ai/api/v1
            </p>
          </div>

          <div>
            <label
              htmlFor="llm-model"
              className="mb-1.5 block text-sm font-semibold text-slate-700"
            >
              Model
            </label>
            <input
              id="llm-model"
              type="text"
              value={model}
              onChange={(e) => setEdited({ ...draft, model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          <div>
            <label
              htmlFor="llm-apikey"
              className="mb-1.5 block text-sm font-semibold text-slate-700"
            >
              API Key <span className="font-normal text-slate-400">(선택)</span>
            </label>
            <div className="flex gap-2">
              <input
                id="llm-apikey"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setEdited({ ...draft, apiKey: e.target.value })}
                placeholder="sk-..."
                autoComplete="off"
                className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="shrink-0 rounded-xl border border-slate-300 px-3 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                {showKey ? "가리기" : "표시"}
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Ollama 등 API 키가 없는 OpenAI 호환 호스트는 비워 두세요.
            </p>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {saved ? "저장됨 ✓" : "저장"}
          </button>
          {test.status === "testing" && (
            <button
              type="button"
              onClick={cancel}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              취소
            </button>
          )}
          <button
            type="button"
            onClick={handleTest}
            disabled={test.status === "testing" || !canSave}
            className="rounded-xl border border-indigo-300 px-5 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {test.status === "testing" ? "테스트 중..." : "🔌 연결 테스트"}
          </button>
          <p role="status" className="text-xs text-slate-400">
            {dirty ? "· 저장하지 않은 변경이 있습니다" : "· 저장된 값과 같습니다"}
          </p>
        </div>

        {test.status === "ok" && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            {test.message}
          </div>
        )}
        {test.status === "error" && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"
          >
            <strong>연결 실패:</strong> {test.message}
            <p className="mt-1 text-xs text-rose-500">
              대부분의 원인은 잘못된 Host/Model/API Key, 호스트의 CORS 비지원,
              또는 OpenAI 호환이 아닌 응답 형식입니다. 에러 메시지에 표시되는
              실제 응답 내용을 확인해 보세요. (API 키 같은 값은 가려서 표시됩니다)
            </p>
          </div>
        )}
      </div>

      <ProgressReset />

      <div className="mt-6">
        <BackupCard />
      </div>
    </div>
  );
}

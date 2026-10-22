"use client";

import { useState } from "react";
import type { LLMSettings } from "@/lib/types";
import { saveSettings } from "@/lib/settings";
import { testConnection } from "@/lib/llm";

interface SettingsTabProps {
  settings: LLMSettings;
  onSaved: (settings: LLMSettings) => void;
}

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

/** ⚙️ 설정: LLM host/model/apiKey (localStorage 저장) */
export default function SettingsTab({ settings, onSaved }: SettingsTabProps) {
  const [host, setHost] = useState(settings.host);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState(settings.apiKey);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const canSave = Boolean(host.trim() && model.trim());

  function handleSave() {
    if (!canSave) return;
    const next = {
      host: host.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
    };
    saveSettings(next);
    onSaved(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleTest() {
    setTest({ status: "testing" });
    try {
      const reply = await testConnection({
        host: host.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      setTest({ status: "ok", message: `연결 성공! LLM 응답: ${reply}` });
    } catch (e) {
      setTest({
        status: "error",
        message: e instanceof Error ? e.message : "연결 테스트에 실패했습니다.",
      });
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
              onChange={(e) => setHost(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
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
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
              className="w-full rounded-xl border border-slate-300 p-3 font-mono text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200"
            />
          </div>

          <div>
            <label
              htmlFor="llm-apikey"
              className="mb-1.5 block text-sm font-semibold text-slate-700"
            >
              API Key
            </label>
            <div className="flex gap-2">
              <input
                id="llm-apikey"
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
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
          <button
            type="button"
            onClick={handleTest}
            disabled={test.status === "testing" || !canSave || !apiKey.trim()}
            className="rounded-xl border border-indigo-300 px-5 py-2.5 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {test.status === "testing" ? "테스트 중..." : "🔌 연결 테스트"}
          </button>
        </div>

        {test.status === "ok" && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
            {test.message}
          </div>
        )}
        {test.status === "error" && (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
            <strong>연결 실패:</strong> {test.message}
            <p className="mt-1 text-xs text-rose-500">
              대부분의 원인은 잘못된 Host/Model/API Key 또는 CORS 비지원
              호스트입니다. (로컬 서버는 Ollama의 OLLAMA_ORIGINS 환경변수로
              CORS를 허용해야 합니다)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

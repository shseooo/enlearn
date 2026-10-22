"use client";

import { useState, useSyncExternalStore } from "react";
import {
  getSettingsServerSnapshot,
  getSettingsSnapshot,
  saveSettings,
  subscribeToSettings,
} from "@/lib/settings";
import FreeWritingTab from "@/components/free-writing-tab";
import TranslationTab from "@/components/translation-tab";
import SettingsTab from "@/components/settings-tab";

type TabId = "free" | "translate" | "settings";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "free", label: "자유 작성", icon: "✍️" },
  { id: "translate", label: "번역 연습", icon: "📝" },
  { id: "settings", label: "설정", icon: "⚙️" },
];

/**
 * localStorage를 외부 스토어로 구독한다.
 * - SSR/하이드레이션: 기본값 스냅샷 (불일치 방지)
 * - 클라이언트: localStorage의 실제 값, 설정 저장 시 즉시 재렌더
 */
function useSettings() {
  const settings = useSyncExternalStore(
    subscribeToSettings,
    getSettingsSnapshot,
    getSettingsServerSnapshot,
  );
  return { settings, update: saveSettings };
}

export default function Home() {
  const [tab, setTab] = useState<TabId>("free");
  const { settings, update } = useSettings();

  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-5">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">
              📚 EnLearn
            </h1>
            <p className="mt-0.5 text-sm text-slate-500">
              매일 문장 연습으로 영어를 늘리세요
            </p>
          </div>

          <nav className="flex gap-1 rounded-xl bg-slate-100 p-1" aria-label="주요 메뉴">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? "page" : undefined}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
                  tab === t.id
                    ? "bg-white text-indigo-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                <span className="mr-1.5" aria-hidden>
                  {t.icon}
                </span>
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">
        {/* 모든 탭을 마운트해 두고 hidden으로 전환 → 탭 이동 시 입력 상태 유지 */}
        <div className={tab === "free" ? "" : "hidden"}>
          <FreeWritingTab
            settings={settings}
            onGoSettings={() => setTab("settings")}
          />
        </div>
        <div className={tab === "translate" ? "" : "hidden"}>
          <TranslationTab
            settings={settings}
            onGoSettings={() => setTab("settings")}
          />
        </div>
        <div className={tab === "settings" ? "" : "hidden"}>
          <SettingsTab settings={settings} onSaved={update} />
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white py-4">
        <p className="mx-auto max-w-3xl px-4 text-center text-xs text-slate-400">
          LLM 설정은 브라우저에만 저장됩니다 · CORS를 지원하는 호스트가
          필요합니다
        </p>
      </footer>
    </>
  );
}

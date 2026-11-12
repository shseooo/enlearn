"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { clearLegacyStorageKeys } from "@/lib/corpus";
import {
  getSettingsServerSnapshot,
  getSettingsSnapshot,
  saveSettings,
  subscribeToSettings,
} from "@/lib/settings";
import FreeWritingTab from "@/components/free-writing-tab";
import TranslationTab from "@/components/translation-tab";
import ReviewTab from "@/components/review-tab";
import SettingsTab from "@/components/settings-tab";
import StorageWarning from "@/components/storage-warning";
import TabWarning from "@/components/tab-warning";

type TabId = "free" | "translate" | "review" | "settings";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "free", label: "자유 작성", icon: "✍️" },
  { id: "translate", label: "번역 연습", icon: "📝" },
  { id: "review", label: "복습", icon: "📆" },
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

  // entryKey가 64비트로 바뀌어 다시 읽히지 않는 옛 키(seen·번역 캐시 v2)를 지운다.
  // 값을 옮기지는 않는다(결정: 마이그레이션 없음) — 죽은 값이 용량만 차지한다(R7-8).
  useEffect(() => {
    clearLegacyStorageKeys();
  }, []);

  /** 탭 목록에서 좌우 방향키/Home/End로 이동한다 (tablist 접근성 규칙) */
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? TABS.length - 1
          : e.key === "ArrowRight"
            ? (index + 1) % TABS.length
            : (index - 1 + TABS.length) % TABS.length;
    const id = TABS[next].id;
    setTab(id);
    document.getElementById(`tab-${id}`)?.focus();
  }

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

          <nav
            role="tablist"
            className="flex gap-1 rounded-xl bg-slate-100 p-1"
            aria-label="주요 메뉴"
          >
            {TABS.map((t, i) => (
              <button
                key={t.id}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
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
        {/* 저장은 번역·자유 작성 탭에서 일어난다. 실패 안내는 탭 하나 안에 두면
            다른 탭에 있는 사용자에게 닿지 않는다(리뷰 1-8). */}
        <StorageWarning />
        {/* 같은 앱이 다른 탭에 열려 있으면 쓰기가 서로를 덮는다(D3-1). */}
        <TabWarning />
        {/* 모든 탭을 마운트해 두고 hidden으로 전환 → 탭 이동 시 입력 상태 유지 */}
        {TABS.map((t) => (
          <div
            key={t.id}
            id={`panel-${t.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${t.id}`}
            // role=tabpanel만 있으면 키보드로 패널에 들어갈 방법이 없다
            tabIndex={0}
            hidden={tab !== t.id}
            className={tab === t.id ? "" : "hidden"}
          >
            {t.id === "free" && (
              <FreeWritingTab
                settings={settings}
                onGoSettings={() => setTab("settings")}
              />
            )}
            {t.id === "translate" && (
              <TranslationTab
                settings={settings}
                onGoSettings={() => setTab("settings")}
              />
            )}
            {t.id === "review" && (
              <ReviewTab
                settings={settings}
                onGoSettings={() => setTab("settings")}
              />
            )}
            {t.id === "settings" && (
              <SettingsTab settings={settings} onSaved={update} />
            )}
          </div>
        ))}
      </main>

      <footer className="border-t border-slate-200 bg-white py-4">
        <div className="mx-auto max-w-3xl space-y-1 px-4 text-center text-xs text-slate-400">
          <p>
            LLM 설정은 브라우저에만 저장됩니다 · CORS를 지원하는 호스트가
            필요합니다
          </p>
          {/* 코퍼스 라이선스는 데이터 파일에만 있고 화면에는 없었다 (CC-BY 출처 표기) */}
          <p>
            연습 문장: Tatoeba(kor-eng) CC-BY 2.0 France · Project Gutenberg
            공개 영역 작품 · <code>npm run corpus</code>로 다시 만들기
          </p>
        </div>
      </footer>
    </>
  );
}

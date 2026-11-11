import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TranslationTab from "../translation-tab";
import { clearCorpusCache, prefillCorpus } from "@/lib/corpus";
import type { CorpusFile } from "@/lib/types";

const { generateMock, evaluateMock, translateMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  evaluateMock: vi.fn(),
  translateMock: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  generateKoreanExercise: generateMock,
  evaluateTranslation: evaluateMock,
  translateSentenceToKorean: translateMock,
  askFollowUp: vi.fn(),
  DIFFICULTY_LABELS: {
    easy: "쉬움 — 기본 시제",
    normal: "보통 — 관용 표현",
    hard: "어려움 — 복잡한 구조",
  },
}));

const settings = { host: "https://h.ai/v1", model: "m", apiKey: "k" };

const dailyFile: CorpusFile = {
  lane: "daily",
  generatedAt: "2026-01-01T00:00:00.000Z",
  license: "CC-BY 2.0 (France)",
  attribution: "Tatoeba",
  sources: [
    { id: "tatoeba", title: "Tatoeba 일상 회화", author: "tatoeba.org", count: 1 },
  ],
  entries: [
    {
      lane: "daily",
      en: "Tom looks very sick.",
      ko: "톰은 많이 아파 보여.",
      hints: ["sick"],
      difficulty: "normal",
      source: "Tatoeba",
      sourceId: "111/222",
    },
  ],
};

const classicFile: CorpusFile = {
  lane: "classic",
  generatedAt: "2026-01-01T00:00:00.000Z",
  license: "Public Domain",
  attribution: "Project Gutenberg",
  sources: [
    {
      id: "alice",
      title: "이상한 나라의 앨리스",
      author: "Lewis Carroll",
      count: 1,
    },
  ],
  entries: [
    {
      lane: "classic",
      en: "Alice was beginning to get very tired.",
      ko: null,
      hints: ["tired"],
      difficulty: "normal",
      source: "이상한 나라의 앨리스",
      sourceId: "alice",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  clearCorpusCache();
});

describe("TranslationTab — 코퍼스 문장", () => {
  it("일상 회화 문장을 받고, 결과에 실제 원문이 표시된다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 82,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks really ill.",
      referenceTranslation: "LLM이 만든 참고 번역",
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    expect(await screen.findByText("톰은 많이 아파 보여.")).toBeInTheDocument();
    expect(screen.getByText(/힌트 단어 1개 보기/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));

    // 코퍼스 연습은 "실제 출판된 원문"을 평가 요청에 함께 보낸다
    expect(evaluateMock).toHaveBeenCalledWith(
      settings,
      "톰은 많이 아파 보여.",
      "Tom looked very sick.",
      "Tom looks very sick.",
    );

    // 참고 번역 자리에 LLM 번역이 아니라 원문이 보인다
    expect(await screen.findByText("Tom looks very sick.")).toBeInTheDocument();
    expect(screen.getByText("📖 원문 (Tatoeba)")).toBeInTheDocument();
    expect(screen.getByText("Tatoeba 문장 #111/222")).toBeInTheDocument();
    expect(
      screen.queryByText("LLM이 만든 참고 번역"),
    ).not.toBeInTheDocument();
  });

  it("이미 받은 문장을 다시 받으면 다시 나온 것임을 알려준다", async () => {
    prefillCorpus("daily", dailyFile);
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    expect(screen.queryByText(/다시 나온/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /다시 받기/ }));
    await screen.findByText(/다시 나온/);
  });

  it("동화 문장은 영어 원문을 한국어로 번역해 보여주고 책 목록을 채운다", async () => {
    prefillCorpus("classic", classicFile);
    translateMock.mockResolvedValue({
      sentence: "앨리스는 아주 지겨워지기 시작했습니다.",
      hints: ["tired"],
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "classic");
    // 책 드롭다운에 코퍼스의 책이 채워진다
    expect(await screen.findByText("이상한 나라의 앨리스 (1)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    expect(
      await screen.findByText("앨리스는 아주 지겨워지기 시작했습니다."),
    ).toBeInTheDocument();
    // 번역은 창작이 아니라 주어진 영어 문장을 옮긴 것이다
    expect(translateMock).toHaveBeenCalledWith(
      settings,
      "Alice was beginning to get very tired.",
    );
    expect(screen.getByText(/한국어는 AI가 영어 원문에서 번역한 것/)).toBeInTheDocument();
  });

  it("코퍼스 파일이 없으면 빌드 방법을 안내한다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    expect(await screen.findByText(/npm run corpus/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

describe("TranslationTab — AI 생성 (기존 방식)", () => {
  it("주제를 입력해 LLM에게 문장을 만든다", async () => {
    generateMock.mockResolvedValue({
      sentence: "여행을 좋아합니다.",
      hints: ["like", "travel"],
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");
    await user.type(screen.getByLabelText(/주제/), "여행");
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));

    expect(await screen.findByText("여행을 좋아합니다.")).toBeInTheDocument();
    expect(generateMock).toHaveBeenCalledWith(settings, "normal", "여행");

    // 힌트는 접힌 상태(defaults)
    const details = screen
      .getByText(/힌트 단어 2개 보기/)
      .closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("like")).toBeInTheDocument();
  });

  it("힌트가 없으면 힌트 섹션을 표시하지 않는다", async () => {
    generateMock.mockResolvedValue({ sentence: "안녕하세요.", hints: [] });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));

    expect(await screen.findByText("안녕하세요.")).toBeInTheDocument();
    expect(screen.queryByText(/힌트 단어/)).not.toBeInTheDocument();
  });
});

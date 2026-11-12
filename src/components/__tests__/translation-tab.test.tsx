import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TranslationTab from "../translation-tab";
import { clearCorpusCache, localDateString, prefillCorpus, seenCount } from "@/lib/corpus";
import { loadLog } from "@/lib/practice";
import { addDays } from "@/lib/practice";
import type { CorpusFile } from "@/lib/types";

const { generateMock, evaluateMock, translateMock, followUpMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  evaluateMock: vi.fn(),
  translateMock: vi.fn(),
  followUpMock: vi.fn(),
}));

vi.mock("@/lib/llm", () => ({
  generateKoreanExercise: generateMock,
  evaluateTranslation: evaluateMock,
  translateSentenceToKorean: translateMock,
  askFollowUp: (...args: unknown[]) => followUpMock(...args),
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

/** 두 번째로 받아보는 코퍼스: 다른 책의 문장(한국어는 코퍼스에 이미 있음) */
const otherBookFile: CorpusFile = {
  ...classicFile,
  sources: [
    {
      id: "looking-glass",
      title: "거울을 통한 이상한 나라의 앨리스",
      author: "Lewis Carroll",
      count: 1,
    },
  ],
  entries: [
    {
      lane: "classic",
      en: "She was trying to see what was the matter with it.",
      ko: "창문 쪽으로 기어갔다.",
      hints: ["window"],
      difficulty: "normal",
      source: "거울을 통한 이상한 나라의 앨리스",
      sourceId: "looking-glass",
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    // 참고 번역 자리에 LLM 번역이 아니라 원문이 보인다
    expect(await screen.findByText("Tom looks very sick.")).toBeInTheDocument();
    expect(screen.getByText("📖 원문 (Tatoeba)")).toBeInTheDocument();
    expect(screen.getByText("Tatoeba 문장 #111/222")).toBeInTheDocument();
    expect(
      screen.queryByText("LLM이 만든 참고 번역"),
    ).not.toBeInTheDocument();
  });

  it("평가 중에는 문장을 다시 받을 수 없다 (늦은 응답이 새 문장 위에 얹히는 것 방지)", async () => {
    let settle!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    evaluateMock.mockImplementation(() => pending);
    prefillCorpus("daily", dailyFile);
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));

    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /다시 받기/ })).toBeDisabled();

    settle({
      score: 80,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks sick.",
    });
    expect(await screen.findByText("Tom looks sick.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeEnabled();
  });

  it("이미 받은 문장을 다시 받으면 이미 푼 문장임을 알려준다", async () => {
    prefillCorpus("daily", dailyFile);
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    expect(screen.queryByText(/다시 나왔/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /다시 받기/ }));
    await screen.findByText(/다시 나왔/);
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
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
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
    // 오류 배너는 다른 화면과 같이 role="alert"로 잡힌다 (리뷰 2-3).
    expect(await screen.findByRole("alert")).toHaveTextContent(/npm run corpus/);
    vi.unstubAllGlobals();
  });

  it("코퍼스 목록을 읽지 못하면 사유를 오류 배너로 알려준다 (리뷰 3-13)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "classic");

    // 목록만 비우고 사유를 삼키면, 사용자는 이유를 모른 채 "문장 받기"를 누른다
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /책 목록을 읽지 못했습니다/,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/npm run corpus/);
    const bookSelect = screen.getByLabelText(/책/);
    expect(bookSelect).toHaveValue("all");
    vi.unstubAllGlobals();
  });

  it("출처를 바꾸면 이전 문장과 평가 카드가 함께 정리된다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 80,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks sick.",
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("Tom looks sick.");

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");

    // 이전 문장의 카드가 새 출처 라벨로 남아있으면 안 된다
    expect(screen.queryByText("톰은 많이 아파 보여.")).not.toBeInTheDocument();
    expect(screen.queryByText("Tom looks sick.")).not.toBeInTheDocument();
  });

  it("문장 받기가 실패해도 이전 평가 카드가 남아있지 않는다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 80,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks sick.",
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("Tom looks sick.");

    clearCorpusCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }),
    );
    await user.click(screen.getByRole("button", { name: /다시 받기/ }));

    expect(await screen.findByText(/npm run corpus/)).toBeInTheDocument();
    expect(screen.queryByText("톰은 많이 아파 보여.")).not.toBeInTheDocument();
    expect(screen.queryByText("Tom looks sick.")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  /*
   * R6-19(리뷰 5): 채점이 실패하는 경로는 화면 테스트가 한 번도 없었다.
   * 실패하면 지난 결과 카드를 지우고 이유를 보여주되, 입력한 문장은 남겨
   * 설정만 고치고 다시 시도할 수 있어야 한다.
   */
  it("채점이 실패하면 이유를 보여주고 지난 결과 카드를 내린다 (R6-19)", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock
      .mockResolvedValueOnce({
        score: 80,
        feedback: "좋습니다.",
        corrections: [],
        betterExpression: "Tom looks sick.",
      })
      .mockRejectedValueOnce(new Error("HTTP 401 Unauthorized — API 키를 확인하세요."));

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    const box = screen.getByLabelText(/내 영어 번역/);
    await user.type(box, "Tom looked sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("Tom looks sick."); // 성공한 평가 카드가 화면에 있다

    await user.click(screen.getByRole("button", { name: /점수 받기/ })); // 이번 시도는 실패

    expect(await screen.findByRole("alert")).toHaveTextContent(/HTTP 401/);
    // 지난 점수 카드가 그대로 남아 "이번 시도도 성공한 것처럼" 보이면 안 된다
    expect(screen.queryByText("Tom looks sick.")).not.toBeInTheDocument();
    // 사용자가 쓴 문장은 남는다
    expect(box).toHaveValue("Tom looked sick.");
    // 실패한 채점은 연습 기록에 남기지 않는다 (성공한 1건만)
    expect(loadLog()).toHaveLength(1);
  });
});

describe("TranslationTab — 취소·출처 변경 경합 (리뷰 3-2)", () => {
  /** 응답을 마음대로 늦출 수 있는 fetch로 바꾼다 */
  function slowFetch() {
    let resolve!: (res: Response) => void;
    const promise = new Promise<Response>((r) => (resolve = r));
    const spy = vi.fn(() => promise);
    vi.stubGlobal("fetch", spy);
    return {
      spy,
      respond: (body: unknown) =>
        resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      restore: () => vi.unstubAllGlobals(),
    };
  }

  it("출처를 바꾸면 늦게 도착한 문장은 화면에도 기록에도 남지 않는다", async () => {
    const fetcher = slowFetch();
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");

    fetcher.respond(dailyFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(window.localStorage.getItem("enlearn.seen.v3")).toBeNull();
    expect(screen.queryByText("톰은 많이 아파 보여.")).not.toBeInTheDocument();
    expect(fetcher.spy).toHaveBeenCalledTimes(1);
    fetcher.restore();
  });

  it("취소한 문장 받기는 그 문장을 영구 소진시키지 않는다", async () => {
    const fetcher = slowFetch();
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.click(screen.getByRole("button", { name: /취소/ }));

    fetcher.respond(dailyFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(window.localStorage.getItem("enlearn.seen.v3")).toBeNull();
    expect(screen.queryByText("톰은 많이 아파 보여.")).not.toBeInTheDocument();
    // 다시 받으면 같은 문장이 여전히 나올 수 있다
    prefillCorpus("daily", dailyFile);
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    expect(await screen.findByText("톰은 많이 아파 보여.")).toBeInTheDocument();
    fetcher.restore();
  });

  // 리뷰 2-7: 출처 셀렉트만 요청을 무효화했다. 책·난이도는 상태를 바꾸기만 해서
  // 이전 조건으로 골라진 문장이 화면에 얹히고 markSeen으로 영구 소진됐다.
  it("문장 받기 중에 난이도를 바꾸면 늦게 도착한 문장이 소진되지 않는다 (리뷰 2-7)", async () => {
    const fetcher = slowFetch();
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.selectOptions(screen.getByLabelText(/난이도/), "hard");
    // 진행 중이던 호출의 finally는 stale()로 reset을 건너뜀 → 변경 쪽에서 푼다
    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeEnabled();

    fetcher.respond(dailyFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(window.localStorage.getItem("enlearn.seen.v3")).toBeNull();
    expect(screen.queryByText("톰은 많이 아파 보여.")).not.toBeInTheDocument();
    fetcher.restore();
  });

  it("문장 받기 중에 책을 바꾸면 이전 책 조건으로 고른 문장이 적용되지 않는다 (리뷰 2-7)", async () => {
    // 책 드롭다운은 코퍼스를 한 번 읽어야 채워진다 → 먼저 책 목록을 채운다
    prefillCorpus("classic", classicFile);
    translateMock.mockResolvedValue({
      sentence: "앨리스는 아주 지겨워지기 시작했습니다.",
      hints: ["tired"],
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "classic");
    await screen.findByText("이상한 나라의 앨리스 (1)");
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("앨리스는 아주 지겨워지기 시작했습니다.");
    const seenBefore = seenCount();

    // 두 번째 받기는 네트워크를 늦추고, 응답에는 다른 책 문장을 담는다
    clearCorpusCache();
    const fetcher = slowFetch();
    await user.click(screen.getByRole("button", { name: /다시 받기/ }));
    await user.selectOptions(screen.getByLabelText(/^책$/), "alice");

    fetcher.respond(otherBookFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.queryByText("창문 쪽으로 기어갔다.")).not.toBeInTheDocument();
    expect(seenCount()).toBe(seenBefore);
    expect(window.localStorage.getItem("enlearn.seen.v3")).not.toContain(
      "looking-glass",
    );
    fetcher.restore();
  });

  it("코퍼스 응답을 취소하면 오류로 표시하지 않는다", async () => {
    const fetcher = slowFetch();
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.click(screen.getByRole("button", { name: /취소/ }));
    await new Promise((r) => setTimeout(r, 0));

    // 취소 오류가 배너로 뜨지 않는다. 배너 자체가 alert로 잡히는 상황은
    // "코퍼스 파일이 없으면…" 테스트가 고정한다(리뷰 2-3).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fetcher.respond(dailyFile);
    fetcher.restore();
  });

  it("문장 받기 중에 출처를 바꾸면 버튼이 다시 활성화된다 (리뷰 1-2)", async () => {
    const fetcher = slowFetch();
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    expect(
      screen.getByRole("button", { name: /문장 가져오는 중/ }),
    ).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");
    // 진행 중이던 호출의 finally는 stale()로 reset을 건너뛴다.
    // 출처 변경 쪽에서 상태를 해제하지 않으면 영구히 잠긴다.
    expect(screen.queryByRole("button", { name: /문장 가져오는 중/ })).toBeNull();
    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeEnabled();
    expect(screen.queryByText("문장을 가져오고 있어요...")).not.toBeInTheDocument();

    // 늦게 도착한 응답이 상태를 다시 잠그지도 않는다
    fetcher.respond(dailyFile);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeEnabled();
    fetcher.restore();
  });

  it("평가 중에 출처를 바꾸면 loading이 꺼지고 결과 카드는 사라진다 (리뷰 1-2)", async () => {
    prefillCorpus("daily", dailyFile);
    let resolveEvaluate!: (value: unknown) => void;
    evaluateMock.mockImplementation(
      () => new Promise((resolve) => (resolveEvaluate = resolve)),
    );

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    expect(
      await screen.findByText("LLM이 번역을 평가하고 있어요..."),
    ).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");
    expect(
      screen.queryByText("LLM이 번역을 평가하고 있어요..."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /문장 받기/ })).toBeEnabled();

    resolveEvaluate({
      score: 70,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks very sick.",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("LLM이 번역을 평가하고 있어요...")).not.toBeInTheDocument();
  });
});

describe("TranslationTab — 추가 질문 히스토리 격리 (리뷰 3-3)", () => {
  it("같은 문장에서 답안만 바꿔도 이전 질문·답변이 새 결과에 섞이지 않는다", async () => {
    // 카드는 result가 계속 살아있는 동안 그대로 마운트돼 있다.
    // key가 없으면 옛 히스토리가 새 result와 함께 askFollowUp에 넘어간다.
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 70,
      feedback: "시제를 attention 없이 쓰세요.",
      corrections: [],
      betterExpression: "Tom looks really ill.",
    });
    followUpMock.mockResolvedValue("현재형이 자연스럽습니다.");

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("Tom looks really ill.");

    await user.type(screen.getByLabelText("추가 질문"), "왜 과거형이 어색해요?");
    await user.click(screen.getByRole("button", { name: /질문하기/ }));
    await screen.findByText(/왜 과거형이 어색해요\?/);
    await screen.findByText("현재형이 자연스럽습니다.");

    // 같은 문장, 다른 답안으로 다시 평가 (문장 받기 없이 = 카드 유지)
    await user.clear(screen.getByLabelText(/내 영어 번역/));
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom is looking very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("시제를 attention 없이 쓰세요.");

    expect(screen.queryByText(/왜 과거형이 어색해요\?/)).not.toBeInTheDocument();
    expect(screen.queryByText("현재형이 자연스럽습니다.")).not.toBeInTheDocument();
  });

  // 리뷰 3-9: 카드가 unmount되면 진행 중이던 추가 질문 요청도 끊어야 한다.
  // 끊지 않으면 요청이 대기 예산(240초)까지 달리고 응답은 버려진다.
  it("문장을 새로 받으면 진행 중이던 추가 질문 요청이 취소된다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 70,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks really ill.",
    });
    let followUpSignal: AbortSignal | undefined;
    // askFollowUp(settings, context, result, question, history, { signal })
    followUpMock.mockImplementation(
      (_s: unknown, _c: unknown, _r: unknown, _q: string, _h: unknown, opts?: { signal?: AbortSignal }) => {
        followUpSignal = opts?.signal;
        return new Promise(() => {}); // 절대 끝나지 않는 답변 — 취소되었는지만 확인한다
      },
    );

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await user.type(screen.getByLabelText("추가 질문"), "왜 어색해요?");
    await user.click(screen.getByRole("button", { name: /질문하기/ }));
    // 답변을 기다리는 중이다 (요청이 실제로 떠 있는지 확인)
    await screen.findByText("답변을 받고 있어요...");
    expect(followUpSignal?.aborted).toBe(false);

    await user.click(screen.getByRole("button", { name: /다시 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");

    // 평가 카드가 unmount됐다 — 남은 요청도 함께 끊긴다
    expect(followUpSignal?.aborted).toBe(true);
  });

  it("문장을 새로 받아도 이전 질문이 남지 않는다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 70,
      feedback: "좋습니다.",
      corrections: [],
      betterExpression: "Tom looks really ill.",
    });
    followUpMock.mockResolvedValue("현재형이 자연스럽습니다.");

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await user.type(screen.getByLabelText("추가 질문"), "왜 어색해요?");
    await user.click(screen.getByRole("button", { name: /질문하기/ }));
    await screen.findByText(/왜 어색해요\?/);

    await user.click(screen.getByRole("button", { name: /다시 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    expect(screen.queryByText(/왜 어색해요\?/)).not.toBeInTheDocument();
  });
});

describe("TranslationTab — 연습 기록 연동", () => {
  it("채점이 끝나면 연습 기록에 남고 복습 큐에 들어간다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockResolvedValue({
      score: 80,
      feedback: "좋습니다.",
      corrections: [
        { original: "looked", better: "looks", reason: "현재형이 자연스럽습니다." },
      ],
      betterExpression: "Tom looks really ill.",
    });
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(
      screen.getByLabelText(/내 영어 번역/),
      "Tom looked very sick.",
    );
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("Tom looks very sick.");

    const log = JSON.parse(window.localStorage.getItem("enlearn.log.v1") ?? "[]");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      lane: "daily",
      en: "Tom looks very sick.",
      answer: "Tom looked very sick.",
      score: 80,
    });
    expect(log[0].corrections[0].original).toBe("looked");

    // 코퍼스 문장은 1일 뒤 복습으로 돌아온다
    const queue = JSON.parse(window.localStorage.getItem("enlearn.srs.v1") ?? "[]");
    expect(queue).toHaveLength(1);
    expect(queue[0].ko).toBe("톰은 많이 아파 보여.");
    expect(queue[0].due).toBe(addDays(localDateString(), 1));
  });

  it("취소하면 기록에 남기지 않는다", async () => {
    prefillCorpus("daily", dailyFile);
    evaluateMock.mockImplementation(
      (_s: unknown, _k: string, _a: string, _r: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("abort")));
        }),
    );
    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("톰은 많이 아파 보여.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Tom looked very sick.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByRole("button", { name: /취소/ });
    await user.click(screen.getByRole("button", { name: /취소/ }));

    expect(window.localStorage.getItem("enlearn.log.v1")).toBeNull();
  });
});

describe("TranslationTab — AI 생성", () => {
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
    expect(generateMock).toHaveBeenCalledWith(
      settings,
      "normal",
      "여행",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

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

describe("TranslationTab — AI 생성 기록 id (리뷰 3-10)", () => {
  it("AI 생성 문장을 다시 풀면 기록이 중복되지 않는다", async () => {
    // en(참고 번역)은 모델이 매번 다르게 쓴다. 그걸로 id를 만들면 같은 문장을
    // 두 번 풀었을 때 기록이 늘고 lastAnswerFor가 이전 답을 못 찾는다.
    generateMock.mockResolvedValue({ sentence: "오늘 날씨가 좋네요.", hints: ["weather"] });
    evaluateMock
      .mockResolvedValueOnce({
        score: 60,
        feedback: "첫 평가",
        corrections: [],
        betterExpression: "The weather is nice today.",
        referenceTranslation: "The weather is nice today.",
      })
      .mockResolvedValueOnce({
        score: 85,
        feedback: "두 번째 평가",
        corrections: [],
        betterExpression: "It is a lovely day.",
        referenceTranslation: "It is a lovely day today.",
      });

    render(<TranslationTab settings={settings} onGoSettings={() => {}} />);
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText(/문장 출처/), "ai");
    await user.click(screen.getByRole("button", { name: /문장 받기/ }));
    await screen.findByText("오늘 날씨가 좋네요.");
    await user.type(screen.getByLabelText(/내 영어 번역/), "Today weather good.");
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("첫 평가");

    await user.clear(screen.getByLabelText(/내 영어 번역/));
    await user.type(
      screen.getByLabelText(/내 영어 번역/),
      "The weather is nice today.",
    );
    await user.click(screen.getByRole("button", { name: /점수 받기/ }));
    await screen.findByText("두 번째 평가");

    const log = JSON.parse(window.localStorage.getItem("enlearn.log.v1") ?? "[]");
    expect(log).toHaveLength(1);
    expect(log[0].score).toBe(85);
    expect(log[0].lane).toBe("ai");
  });
});

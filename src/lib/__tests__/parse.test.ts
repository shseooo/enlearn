import { describe, expect, it } from "vitest";
import {
  extractJson,
  normalizeEvaluation,
  parseEvaluation,
  parseSentence,
} from "../parse";

describe("extractJson", () => {
  it("일반 JSON 문자열을 파싱한다", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it("```json 코드펜스가 감싸인 JSON을 파싱한다", () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("JSON 앞뒤에 설명 텍스트가 있어도 추출한다", () => {
    const raw = '좋습니다. 다음 JSON이 평가 결과입니다.\n{"a": 1}\n감사합니다.';
    expect(extractJson(raw)).toEqual({ a: 1 });
  });

  it("JSON이 없으면 에러를 던진다", () => {
    expect(() => extractJson("안녕하세요")).toThrow(/JSON을 찾을 수 없습니다/);
  });

  it("JSON이 깨져 있으면 에러를 던진다", () => {
    expect(() => extractJson('{"a":')).toThrow(/파싱할 수 없습니다/);
  });
});

describe("parseEvaluation", () => {
  it("전체 필드가 있는 응답을 파싱한다", () => {
    const raw = JSON.stringify({
      score: 75,
      feedback: "전반적으로 괜찮아요.",
      corrections: [
        { original: "goed", better: "went", reason: "go의 과거형은 went" },
      ],
      betterExpression: "I went to the park.",
    });
    const r = parseEvaluation(raw);
    expect(r.score).toBe(75);
    expect(r.feedback).toBe("전반적으로 괜찮아요.");
    expect(r.corrections).toEqual([
      { original: "goed", better: "went", reason: "go의 과거형은 went" },
    ]);
    expect(r.betterExpression).toBe("I went to the park.");
    expect(r.referenceTranslation).toBeUndefined();
  });

  it("점수를 0~100으로 클램핑한다", () => {
    expect(parseEvaluation('{"score": 150}').score).toBe(100);
    expect(parseEvaluation('{"score": -10}').score).toBe(0);
  });

  it("문자열 점수도 숫자로 변환한다", () => {
    expect(parseEvaluation('{"score": "85"}').score).toBe(85);
  });

  it("필드가 누락되어도 기본값으로 채운다", () => {
    const r = parseEvaluation("{}");
    expect(r).toEqual({
      score: 0,
      feedback: "",
      corrections: [],
      betterExpression: "",
    });
  });

  it("corrections가 문자열 배열이어도 정규화한다", () => {
    const r = parseEvaluation('{"corrections": ["goed -> went"]}');
    expect(r.corrections).toEqual([
      { original: "goed -> went", better: "", reason: "" },
    ]);
  });

  it("corrections의 다른 키 이름(issue/fix/explanation)도 인식한다", () => {
    const r = normalizeEvaluation({
      corrections: [
        { issue: "I am agree", fix: "I agree", explanation: "agree는 동사" },
      ],
    });
    expect(r.corrections).toEqual([
      { original: "I am agree", better: "I agree", reason: "agree는 동사" },
    ]);
  });

  it("번역 연습용 referenceTranslation도 함께 파싱한다", () => {
    const r = parseEvaluation(
      '{"score": 90, "referenceTranslation": "I went to the park yesterday."}',
    );
    expect(r.referenceTranslation).toBe("I went to the park yesterday.");
  });
});

describe("parseEvaluation (평문 폴백)", () => {
  it("JSON 지시를 무시한 평문 응답도 feedback으로 살린다", () => {
    const raw =
      "Your sentence is quite good. The grammar is mostly correct, but you should use past tense.";
    const r = parseEvaluation(raw);
    expect(r.feedback).toBe(raw);
    expect(r.score).toBe(0);
    expect(r.corrections).toEqual([]);
  });

  it("평문 안에 점수처럼 보이는 값이면 추출한다", () => {
    const r = parseEvaluation("Overall it is fine. Score: 72\nGood job.");
    expect(r.score).toBe(72);
    expect(r.feedback).toContain("Good job.");
  });

  it("점수처럼 보이는 숫자가 없으면 0점", () => {
    const r = parseEvaluation("안녕하세요, 도움이 필요하신가요?");
    expect(r.score).toBe(0);
  });

  it("100을 초과하는 숫자는 점수로 취급하지 않는다", () => {
    const r = parseEvaluation("I give it 999 points out of 100.");
    expect(r.score).toBe(0);
  });
});

describe("parseSentence (평문 폴백)", () => {
  it("JSON 없이 평문 문장을 반환하면 첫 줄을 문장으로 사용한다", () => {
    expect(parseSentence("어제 공원에 갔다.")).toBe("어제 공원에 갔다.");
  });

  it("'문장:' 같은 접두사는 제거한다", () => {
    expect(parseSentence("문장: 오늘 날씨가 좋네요.")).toBe("오늘 날씨가 좋네요.");
    expect(parseSentence("Sentence: The weather is nice today.")).toBe(
      "The weather is nice today.",
    );
  });

  it("여러 줄이면 라벨 줄은 건너뛰고 첫 실제 문장 줄을 사용한다", () => {
    expect(parseSentence("문장입니다:\n밥을 먹었어요.\n끝.")).toBe("밥을 먹었어요.");
  });
});

describe("parseSentence", () => {
  it("sentence 필드를 반환한다", () => {
    expect(parseSentence('{"sentence": "어제 공원에 갔다."}')).toBe(
      "어제 공원에 갔다.",
    );
  });

  it("코드펜스가 있어도 파싱한다", () => {
    expect(parseSentence('```json\n{"sentence": "안녕?"}\n```')).toBe("안녕?");
  });

  it("sentence가 없으면 에러를 던진다", () => {
    expect(() => parseSentence('{"foo": 1}')).toThrow(/문장\(sentence\)/);
  });
});

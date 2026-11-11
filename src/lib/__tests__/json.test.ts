import { describe, expect, it } from "vitest";
import { extractJson, repairJson } from "../json";

describe("repairJson — 이스케이프 처리 (리뷰 3-6)", () => {
  it("이스케이프된 따옴표가 들어간 잘린 JSON을 복원한다", () => {
    const input = String.raw`{"fb": "a \" } b {", "score": 3`;
    // 문자열 안의 \" 때문에 inString 상태가 어긋나면 끝에 잘못된 '"'가 붙는다
    expect(repairJson(input)).toBe(`${input}}`);
    expect(extractJson(input)).toEqual({ fb: 'a " } b {', score: 3 });
  });

  it("이미 완전한 JSON에는 손대지 않는다", () => {
    const input = String.raw`{"feedback": "he said \"stop", "score": 5}`;
    expect(repairJson(input)).toBe(input);
    expect(extractJson(input)).toEqual({ feedback: 'he said "stop', score: 5 });

    const full = String.raw`{"feedback": "he said \"stop\"", "score": 5}`;
    expect(repairJson(full)).toBe(full);
    expect(extractJson(full)).toEqual({ feedback: 'he said "stop"', score: 5 });
  });

  it("잘못된 이스케이프(\\{ \\} \\[)는 역슬래시만 지운다", () => {
    const input = String.raw`{"feedback": "Use \{braces\} and \[brackets\]", "score": 90}`;
    expect(extractJson(input)).toEqual({
      feedback: "Use {braces} and [brackets]",
      score: 90,
    });
  });

  it("정상 이스케이프(\\\\, \\n, \\uXXXX)는 보존한다", () => {
    const input = String.raw`{"path": "C:\\new\\dir", "note": "line1\nline2 ©", "score": 1}`;
    expect(extractJson(input)).toEqual({
      path: "C:\\new\\dir",
      note: "line1\nline2 ©",
      score: 1,
    });
  });

  it("닫지 않은 문자열과 괄호를 순서대로 메운다", () => {
    expect(repairJson(String.raw`{"a": "unclosed`)).toBe(String.raw`{"a": "unclosed"}`);
    expect(repairJson(String.raw`{"a": [1, 2`)).toBe(String.raw`{"a": [1, 2]}`);
    expect(repairJson(String.raw`{"a": {"b": "x\"y"`)).toBe(String.raw`{"a": {"b": "x\"y"}}`);
  });
});

describe("extractJson — 손상된 응답", () => {
  it("중첩 배열이 잘린 응답도 복원한다", () => {
    const raw = '답변입니다:\n```json\n{"score": 82, "corrections": [{"original": "a", "better": "b"}\n```';
    expect(extractJson(raw)).toEqual({
      score: 82,
      corrections: [{ original: "a", better: "b" }],
    });
  });

  it("설명 문구 뒤에 붙은 JSON을 꺼낸다", () => {
    const raw = '물론이죠!\n{"score": 55, "feedback": "화이팅"}\n도움더 될까요?';
    expect(extractJson(raw)).toEqual({ score: 55, feedback: "화이팅" });
  });
});

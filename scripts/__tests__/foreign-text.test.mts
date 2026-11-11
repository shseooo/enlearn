/** 번역 검사 규칙(scripts/lib/foreign-text.ts)의 고정 테스트. */
import { describe, expect, it } from "vitest";

import { foreignLetterRuns, hasHangul } from "../lib/foreign-text.ts";

describe("foreignLetterRuns", () => {
  it("한글만 있으면 조각이 없다", () => {
    expect(foreignLetterRuns("두꺼비는 그냥 마음을 놓았다.")).toEqual([]);
  });

  it("라틴 문자를 조각으로 모아 돌려준다", () => {
    expect(foreignLetterRuns("이 TV 프로그램은 어린이용이다.")).toEqual(["TV"]);
    expect(foreignLetterRuns("호스트가 A와 B를 바꿨다.")).toEqual(["A", "B"]);
  });

  it("허용 목록에 있는 조각은 넘긴다", () => {
    const allowed = new Set(["TV"]);
    expect(foreignLetterRuns("이 TV 프로그램은 어린이용이다.", allowed)).toEqual([]);
  });

  // 일부러 오염시킨 시료 문자열이다. 검사기가 잡아야만 하는 값이다.
  it("일본 가나·중일한자·키릴·태국 문자를 모두 잡는다", () => {
    expect(foreignLetterRuns("소용이 없으므로 재시도하지 않는다")).toEqual([]); // 온전한 한국어
    expect(foreignLetterRuns("소용がないので 재시도")).toEqual(["がないので"]);
    expect(foreignLetterRuns("사람들이 自分を 찾아주는")).toEqual(["自分を"]);
    expect(foreignLetterRuns("그는 無理라고 했다")).toEqual(["無理"]);
    expect(foreignLetterRuns("тогда 두꺼비는")).toEqual(["тогда"]);
    expect(foreignLetterRuns("나เอง은 그렇게")).toEqual(["เอง"]);
  });

  it("외국어 문자에 이어지는 숫자는 같은 조각으로 본다", () => {
    // 허용 목록이 "C"라도 "C20"까지 넘기지는 않는다. 부분 일치로 허용 범위가 커지면 안 된다.
    expect(foreignLetterRuns("C와 C20이 같다", new Set(["C"]))).toEqual(["C20"]);
  });

  it("숫자·구두점·기호는 외국어로 보지 않는다", () => {
    expect(foreignLetterRuns("1, 3, 5는 홀수이며 1000엔으로 충분하다 — 정말?")).toEqual([]);
  });

  it("허용 목록은 조각 전체가 일치할 때만 넘긴다", () => {
    // 부분 일치로 넘기면 "C"가 허용된 화면에 "C20" 같은 조각이 슬쩍 통과한다.
    // check-translations, audit, 커밋 데이터 테스트가 같이 쓰는 안전판이다(리뷰 2-2).
    expect(foreignLetterRuns("C20이 같다", new Set(["C20"]))).toEqual([]);
    expect(foreignLetterRuns("C20이 같다", new Set(["C"]))).toEqual(["C20"]);
  });
});

describe("hasHangul", () => {
  it("완성형 음절과 한글 자모를 모두 한글로 본다", () => {
    expect(hasHangul("문장")).toBe(true);
    expect(hasHangul("ㄱㅏ")).toBe(true);
  });

  it("한글이 없으면 false", () => {
    expect(hasHangul("no korean here")).toBe(false);
    expect(hasHangul("12345 —")).toBe(false);
  });

  it("CJK 한자·일본 가나·Bamum은 한글이 아니다 (리뷰 1-5)", () => {
    // 예전 빌더 판정([\u3131-\uD79D])은 이 구간을 모두 한글로 봤다.
    expect(hasHangul("猫が寝ています.")).toBe(false);
    expect(hasHangul("我今天去学校.")).toBe(false);
    expect(hasHangul("ꀀꀁꀂ")).toBe(false);
  });
});

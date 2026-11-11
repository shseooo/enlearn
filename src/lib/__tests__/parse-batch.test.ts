import { describe, expect, it } from "vitest";
import { parseTranslationBatch } from "../parse-batch";

const ENS = [
  "The rabbit hopped away quickly.",
  "Alice was beginning to get very tired.",
  '"What do you mean by that?" said the Caterpillar.',
];

describe("parseTranslationBatch", () => {
  it("번호(i)로 대응을 맞추고 코드펜스·잡담은 무시한다", () => {
    const raw = `물론이죠:\n\`\`\`json\n{"items":[
      {"i":1,"ko":"토끼가 잽싸게 뛰어가 버렸다.","hints":["rabbit","quickly"]},
      {"i":2,"ko":"앨리스는Very 지겨워지기 시작했다.","hints":["alice"]}
    ]}\n\`\`\``;
    const map = parseTranslationBatch(raw, ENS);
    expect(map.size).toBe(2);
    expect(map.get(ENS[0])?.ko).toBe("토끼가 잽싸게 뛰어가 버렸다.");
    expect(map.get(ENS[1])?.ko).toContain("지겨워지기");
    expect(map.get(ENS[1])?.hints).toEqual(["alice"]);
  });

  it("0-based 번호도 받아들인다", () => {
    const zeroBased = parseTranslationBatch(
      JSON.stringify({ items: [{ i: 0, ko: "토끼 문장입니다." }] }),
      ENS,
    );
    expect(zeroBased.get(ENS[0])?.ko).toBe("토끼 문장입니다.");
  });

  // 리뷰 2-1: 기준을 항목마다 정하면 0-based 목록에서 첫 항목만 맞고
  // 두 번째 항목부터 한 칸 어긋난 번역이 코퍼스에 영구로 남는다.
  it("0-based 목록은 여러 항목도 제자리에 붙인다 (리뷰 2-1)", () => {
    const reasons: string[] = [];
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 0, ko: "토끼 문장입니다." },
          { i: 1, ko: "앨리스 문장입니다." },
          { i: 2, ko: "애벌레 문장입니다." },
        ],
      }),
      ENS,
      (reason) => reasons.push(reason),
    );
    expect([...map.keys()]).toEqual(ENS);
    expect(map.get(ENS[0])?.ko).toBe("토끼 문장입니다.");
    expect(map.get(ENS[1])?.ko).toBe("앨리스 문장입니다.");
    expect(map.get(ENS[2])?.ko).toBe("애벌레 문장입니다.");
    expect(reasons).toEqual([]);

    // 일부만 답한 0-based 목록도 어긋나지 않는다
    const partial = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 0, ko: "토끼 문장입니다." },
          { i: 2, ko: "애벌레 문장입니다." },
        ],
      }),
      ENS,
    );
    expect([...partial.keys()]).toEqual([ENS[0], ENS[2]]);
  });

  it("번호 기준이 섞이면 번호로는 대응시키지 않고 사유를 남긴다 (리뷰 2-1)", () => {
    const reasons: string[] = [];
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 0, ko: "토끼 문장입니다." },
          { i: 1, ko: "앨리스 문장입니다." },
          { i: 3, ko: "애벌레 문장입니다." },
        ],
      }),
      ENS,
      (reason) => reasons.push(reason),
    );
    expect(map.size).toBe(0);
    expect(reasons).toHaveLength(1);
  });

  it("식별자 없는 배열은 개수가 맞을 때만 순서대로 대응시킨다 (리뷰 3-8)", () => {
    const sameSize = parseTranslationBatch(
      JSON.stringify([{ ko: "첫째 문장입니다." }, { ko: "둘째 문장입니다." }, { ko: "셋째 문장입니다." }]),
      ENS,
    );
    expect(sameSize.size).toBe(3);
    expect(sameSize.get(ENS[2])?.ko).toBe("셋째 문장입니다.");

    // 개수가 모자라면 자릿수 추측으로 엉뚱한 문장에 붙인다 → 전부 폐기
    const partial = parseTranslationBatch(
      JSON.stringify([{ ko: "첫 번째 문장입니다." }, { ko: "세 번째 문장입니다." }]),
      ENS,
    );
    expect(partial.size).toBe(0);
  });

  it("번호·원문 없는 항목은 버린다 (리뷰 3-8)", () => {
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 1, ko: "번호 있는 첫 문장입니다." },
          { ko: "번호 없는 항목입니다." },
          { ko: "또 다른 번호 없는 항목입니다." },
        ],
      }),
      ENS,
    );
    expect([...map.keys()]).toEqual([ENS[0]]);
    expect(map.get(ENS[1])).toBeUndefined();
    expect(map.get(ENS[2])).toBeUndefined();
  });

  it("번호가 어긋나면 원문(en) 키로 대조하고, 그것도 없으면 버린다", () => {
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 99, en: "alice was beginning to get very tired", ko: "앨리스 문장." },
          { i: 98, en: "완전히 다른 문장입니다.", ko: "환각 항목." },
        ],
      }),
      ENS,
    );
    expect(map.size).toBe(1);
    expect(map.get(ENS[1])?.ko).toBe("앨리스 문장.");
  });

  it("한국어가 아니거나 지나치게 짧은 번역은 폐기한다", () => {
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          { i: 1, ko: "The rabbit hopped away." },
          { i: 2, ko: "네." },
          { i: 3, ko: " caterpillar 가 말했다. " },
        ],
      }),
      ENS,
    );
    expect([...map.keys()]).toEqual([ENS[2]]);
  });

  it("힌트는 최대 4개·문자열만 남긴다", () => {
    const map = parseTranslationBatch(
      JSON.stringify({
        items: [
          {
            i: 1,
            ko: "토끼가 달아났다.",
            hints: ["rabbit", 7, "", "  ", "hopped", "away", "quickly", "very"],
          },
        ],
      }),
      ENS,
    );
    expect(map.get(ENS[0])?.hints).toEqual(["rabbit", "hopped", "away", "quickly"]);
  });

  it("파싱 불가능한 응답은 빈 결과를 돌려준다 (빌드가 죽지 않게)", () => {
    expect(parseTranslationBatch("죄송합니다, 못 했어요.", ENS).size).toBe(0);
    expect(parseTranslationBatch("", ENS).size).toBe(0);
    expect(parseTranslationBatch("{ 잘린 JSON", ENS).size).toBe(0);
  });
});

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

  it("0-based 번호와 배열만 온 응답도 받아준다", () => {
    const zeroBased = parseTranslationBatch(
      JSON.stringify({ items: [{ i: 0, ko: "토끼 문장입니다." }] }),
      ENS,
    );
    expect(zeroBased.get(ENS[0])?.ko).toBe("토끼 문장입니다.");

    const bareArray = parseTranslationBatch(
      JSON.stringify([{ ko: "첫째." }, { ko: "둘째." }]),
      ENS,
    );
    expect(bareArray.size).toBe(2);
    expect(bareArray.get(ENS[1])?.ko).toBe("둘째.");
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

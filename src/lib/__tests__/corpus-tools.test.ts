import { describe, expect, it } from "vitest";
import {
  buildFrequency,
  computeGradeCutoffs,
  difficultyParts,
  entryKey,
  gradeDifficulty,
  isPracticeSentence,
  lemma,
  normalizeKey,
  normalizeProse,
  pickHints,
  splitSentences,
  stripGutenbergBoilerplate,
  stripWikisourceMarkup,
  words,
} from "../corpus-tools";

const GUTENBERG_HEAD = [
  "The Project Gutenberg eBook of Alice's Adventures in Wonderland",
  "This eBook is for the use of anyone...",
  "*** START OF THE PROJECT GUTENBERG EBOOK ALICE'S ADVENTURES IN WONDERLAND ***",
  "",
  "ALICE'S ADVENTURES IN WONDERLAND",
  "",
  "CHAPTER I",
  "",
  "Down the Rabbit-Hole",
  "",
  "Alice was beginning to get very tired of sitting by her sister on the bank.",
  `Where's the use of a book," thought Alice, "without pictures or conversation?`,
  "",
  "*** END OF THE PROJECT GUTENBERG EBOOK ALICE'S ADVENTURES IN WONDERLAND ***",
  "Do not remove this note.",
].join("\n");

describe("stripGutenbergBoilerplate", () => {
  it("머리말과 꼬리말을 잘라낸다", () => {
    const body = stripGutenbergBoilerplate(GUTENBERG_HEAD);
    expect(body).toContain("Alice was beginning to get very tired");
    expect(body).not.toContain("Project Gutenberg eBook of Alice");
    expect(body).not.toContain("Do not remove this note");
  });
});

describe("stripWikisourceMarkup", () => {
  it("템플릿·링크·제목 마크업을 걷어낸다", () => {
    const out = stripWikisourceMarkup(
      "{{infobox|title=x}}\n== Chapter I ==\nSee [[Rabbit (Alice_in_Wonderland)|rabbit]].",
    );
    expect(out).not.toContain("infobox");
    expect(out).not.toContain("== Chapter I ==");
    expect(out).toContain("rabbit.");
  });
});

describe("normalizeProse", () => {
  it("줄바꿈 하이픈을 이어 붙이고 줄구분을 문단 하나로 합친다", () => {
    const out = normalizeProse("The ra-\nbbit went on.\n\nNext paragraph.");
    expect(out).toContain("The rabbit went on.");
    expect(out).toContain("Next paragraph.");
  });

  it("구식 큰따옴표와 합자를 정규화한다", () => {
    const out = normalizeProse("He said \u201chello\u201d and ran \ufb01rst.");
    expect(out).toContain('"hello"');
    expect(out).toContain("first");
  });
});

describe("splitSentences", () => {
  it("약어 뒤에서는 문장을 나누지 않는다", () => {
    const parts = splitSentences("Dr. Jones went away. He was late.");
    expect(parts).toEqual(["Dr. Jones went away.", "He was late."]);
  });

  it("물음표 뒤 닫는 따옴표를 문장에 붙인다", () => {
    const parts = splitSentences(
      'Where is it?" she asked. "I cannot find it.',
    );
    expect(parts[0]).toBe('Where is it?" she asked.');
    expect(parts[1]).toBe('"I cannot find it.');
  });

  it("말줄임표에서는 나누지 않는다", () => {
    const parts = splitSentences("Well... I do not know. Really I do not.");
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("Well...");
  });

  it("따옴표로 시작하는 대화문도 문장으로 잡는다", () => {
    const parts = splitSentences(
      "Alice looked round. \"Be off, home!\" said the Queen.",
    );
    expect(parts.some((p) => p.startsWith('"Be off, home!"'))).toBe(true);
  });

  it("약어·말줄임표·따옴표가 섞인 지문을 정확히 나눈다 (회귀 스냅샷)", () => {
    const text =
      "Mr. Jones went to St. Paul. He waited by the door... and left. " +
      ' "Are you coming?" she asked. "I cannot wait long." ' +
      "The train was late; however, it arrived at last. Everyone cheered.";
    expect(splitSentences(text)).toEqual([
      "Mr. Jones went to St. Paul.",
      "He waited by the door... and left.",
      '"Are you coming?" she asked.',
      '"I cannot wait long."',
      "The train was late; however, it arrived at last.",
      "Everyone cheered.",
    ]);
  });

  it("책 한 권 분량의 텍스트도 선형 시간으로 처리한다", () => {
    // 이전 구현은 토큰마다 tokens.slice(i + 1)를 복사했다 (200k 토큰에 5초)
    const unit =
      "The little girl opened the door and saw the rabbit. Dr. Jones waited. ";
    const text = unit.repeat(10_000); // ~170k 토큰
    const started = performance.now();
    const parts = splitSentences(text);
    const elapsed = performance.now() - started;
    expect(parts.length).toBe(20_000);
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe("isPracticeSentence", () => {
  it("짧은 대화문은 받아들인다", () => {
    expect(
      isPracticeSentence("I do not think it is very pretty.", {
        minWords: 4,
        maxWords: 16,
      }),
    ).toBe(true);
  });

  it("너무 짧은 문장과 동사 없는 나열은 거른다", () => {
    expect(isPracticeSentence("Yes, I do.")).toBe(false);
    expect(isPracticeSentence("Chapter the First")).toBe(false);
    expect(
      isPracticeSentence("The little girl in the red velvet coat", {
        minWords: 4,
      }),
    ).toBe(false);
  });

  it("제목·장 구분·전부 대문자는 거른다", () => {
    expect(isPracticeSentence("CHAPTER II. The Pool of Tears.")).toBe(false);
    expect(isPracticeSentence("THE END OF THE STORY AND EVERYTHING IS SAFE.")).toBe(
      false,
    );
  });

  it("구두점이 과도하거나 숫자가 많은 문장은 거른다", () => {
    expect(
      isPracticeSentence("One, two, three, four, five, six, seven, eight, nine."),
    ).toBe(false);
  });

  it("비영어 문자가 섞인 문장은 거른다", () => {
    expect(isPracticeSentence("He said \u3042\u308a\u304c\u3068\u3046 and left.")).toBe(false);
  });

  // R6-13(resolved.md "hasVerb 필터"): 커밋된 코퍼스에 남은 잡음 두 종류를 따로 거른다.
  it("문장 안·끝에 붙은 장 제목은 거른다 (R6-13)", () => {
    for (const noisy of [
      "Glinda The Good Witch Grants Dorothy's Wish Chapter XXIV.",
      "The Garden of Live Flowers CHAPTER III.",
      "How Dorothy Saved the Scarecrow Chapter IV.",
      // 앞두("Chapter …")만 걸러던 이전 규칙은 문장 중간에 붙은 제목을 놓친다.
      "The Story Chapter IV. It was a long day and everyone rested.",
    ]) {
      expect(isPracticeSentence(noisy)).toBe(false);
    }
    // 정상 문장에서의 "book I" 언급은 잡지 않는다(한 글자 로마숫자는 문장 끝에서만 인정).
    expect(
      isPracticeSentence("He opened the book I had given him that winter, and read it twice."),
    ).toBe(true);
  });

  it("영어 기능어가 없는 비영어 문장은 거른다 (R6-13)", () => {
    expect(
      isPracticeSentence(
        "Duplex libelli dos est: quod risum movet, Et quod prudenti vitam consilio monet.",
      ),
    ).toBe(false);
    expect(
      isPracticeSentence("The queen was very angry and she shouted at the soldiers."),
    ).toBe(true);
  });

  it("축약형은 기능어로 인정한다 (R6-13)", () => {
    // "there's"처럼 어절 하나에 붙은 기능어도 비영어 판정에서 넘어간다.
    expect(isPracticeSentence("Well, there's one thing pretty sure, said the old woman.")).toBe(
      true,
    );
  });
});

describe("난이도", () => {
  const stats = buildFrequency([
    "The little girl opened the door and saw the white rabbit under the tree.",
    "The rabbit ran away and the girl went home to her mother in the house.",
    "She was very tired and she sat down by the fire with her cat.",
    "The door was locked but the window was open and the wind came in.",
    "He looked at the little map and then he walked on through the wood.",
    "The boy who lost his way in the forest found a small house of bread.",
    "When the king came into the room everyone stood up and looked at him.",
    "The queen was angry and she called her soldiers to take the boy away.",
    "I do not know what you mean by that story about the old man.",
    "The little bird sang a beautiful song in the tree above the garden.",
    "The girl and the boy went down to the river and played in the water.",
    "They found a golden key on the floor but it did not fit any door.",
    "The king gave his daughter a ring of gold and she smiled at him.",
    "In the morning the rabbit came back to the hole and ate his food.",
    "The old woman lived alone in a little house at the end of the lane.",
    "Nobody said anything for a long time and then the boy began to cry.",
    "She put on her coat and her boots and went out into the cold snow.",
    "The cat sat on the mat and watched the little mouse by the wall.",
    "Once upon a time there was a king who had three beautiful daughters.",
    "The wind blew hard all night and the next day the snow covered everything.",
    "He told her that she must not open the door for any stranger.",
    "The three friends walked through the snow to the village church.",
    "The child laughed and clapped her hands and ran to her father.",
    "There was a large fire in the room and the cat slept by it.",
    "Nobody knows where the rabbit went or when he will come back.",
    "The queen ate her cake slowly and looked at the little girl.",
    "She wrote a letter to her friend and posted it in the box.",
    "The boy ran to the gate but the dog was waiting for him there.",
    "The king and his men rode out into the forest to hunt the stag.",
    "At last the door opened and the girl walked into the garden.",
    "The old man sat by the fire and thought about the past.",
    "The next morning they found the letter on the table.",
    "She did not want to leave the house in such bad weather.",
    "The rabbit looked at her and then went down the hole.",
    "The little house stood at the top of the hill.",
    "The king was glad and he gave a great feast.",
    "The boy opened the box and saw the golden key.",
    "The girl closed the book and put it on the shelf.",
    "The sun went down and the stars came out.",
    "He walked home in the dark and did not look back.",
    "The cat jumped over the wall and ran away.",
    "The door opened and a stranger came in.",
    "They sat down and ate their supper.",
    "She sang a song to the child.",
    "The wind stopped and the sea was calm.",
  ]);

  it("어휘 빈도 지도를 만든다", () => {
    expect(stats.freq.get("rabbit")).toBeGreaterThan(3);
    expect(stats.freq.get("antelopexyz")).toBeUndefined();
  });

  it("짧고 쉬운 문장은 easy", () => {
    expect(gradeDifficulty("The cat sat on the mat.", stats)).toBe("easy");
  });

  it("길고 희귀 어휘가 많은 문장은 hard", () => {
    const hard =
      "The obstreperous porcupine endeavoured to penetrate the trellis while the gardener protested.";
    expect(gradeDifficulty(hard, stats)).toBe("hard");
  });

  it("그 외는 normal이고 특징 값도 확인할 수 있다", () => {
    const plain = "The little girl opened the door and saw the rabbit.";
    const parts = difficultyParts(plain, stats);
    expect(parts.wordCount).toBe(10);
    expect(gradeDifficulty(plain, stats)).toBe("normal");
  });

  it("백분위 기준선을 쓰면 코퍼스 안에서 상대적으로 나뉜다", () => {
    // 짧은 30문장 + 길고 희귀 어휘가 많은 30문장
    const sentences: string[] = [];
    for (let i = 1; i <= 30; i++)
      sentences.push(`The cat sat on the mat and purred${i}.`);
    for (let i = 1; i <= 30; i++)
      sentences.push(
        `The obstreperous porcupine endeavoured to penetrate the trellis, ` +
          `while the gardener protested and the boy watched${i}.`,
      );
    const laneStats = buildFrequency(sentences);
    laneStats.gradeCutoffs = computeGradeCutoffs(sentences, laneStats, {
      easyRatio: 0.4,
      hardRatio: 0.4,
    });

    const counts = { easy: 0, normal: 0, hard: 0 };
    for (const s of sentences) counts[gradeDifficulty(s, laneStats)]++;

    expect(gradeDifficulty(sentences[0], laneStats)).toBe("easy");
    expect(gradeDifficulty(sentences[45], laneStats)).toBe("hard");
    expect(counts.easy).toBeGreaterThan(0);
    expect(counts.hard).toBeGreaterThan(0);
  });

  it("기준선이 무의미하면 절대 임계값으로 폴백한다", () => {
    const fallback = { ...stats, gradeCutoffs: { easy: 50, hard: 10 } }; // hard ≤ easy → 무효
    expect(gradeDifficulty("The cat sat on the mat.", fallback)).toBe("easy");
    expect(
      gradeDifficulty(
        "The obstreperous porcupine endeavoured to penetrate the trellis.",
        fallback,
      ),
    ).toBe("hard");
  });
});

describe("pickHints", () => {
  const stats = buildFrequency([
    "The little girl opened the golden door and saw the rabbit.",
    "The girl opened the door and the rabbit ran out into the garden.",
    "She opened the little door and looked through into the garden.",
  ]);

  it("2~4개의 영어 단어만 돌려준다", () => {
    const hints = pickHints(
      "The little girl opened the golden door and saw the rabbit.",
      stats,
    );
    expect(hints.length).toBeLessThanOrEqual(4);
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h).toMatch(/^[a-z]+$/);
      expect(h).not.toBe("the");
    }
  });

  it("드문 단어를 먼저 고른다", () => {
    const hints = pickHints(
      "The little girl opened the golden door and saw the rabbit.",
      stats,
    );
    expect(hints).toContain("golden");
  });

  it("문장 첫 단어와 문장 중간 고유명사는 힌트에서 뺀다", () => {
    const hints = pickHints(
      "Alice opened the golden door with a small key today.",
      stats,
    );
    expect(hints).not.toContain("alice");
    expect(hints).not.toContain("open");
  });

  it("구두점 파편·숫자·고유명사는 힌트로 쓰지 않는다", () => {
    const hints = pickHints(
      "She shouted TWEEDLE and counted 123 golden coins together.",
      stats,
    );
    for (const h of hints) expect(h).toMatch(/^[a-z]+$/);
    expect(hints).not.toContain("tweedle");
    expect(hints).not.toContain("123");
  });

  // R6-14: seed 인자와 회전 로직은 죽은 코드였다(유일한 호출부는 인자 두 개로 부른다).
  // 힌트는 코퍼스 키·캐시와 짝을 이루는 값이라 호출마다 같아야 한다.
  it("힌트는 seed 없이 결정론적이다 (R6-14)", () => {
    const sentence =
      "The golden rabbit opened the little door and ran through the secret garden.";
    const a = pickHints(sentence, stats);
    const b = pickHints(sentence, stats);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(pickHints.length).toBe(2); // (sentence, stats) — seed 인자는 없다
  });
});

describe("lemma", () => {
  it("활용형을 사전형으로 줄인다", () => {
    expect(lemma("spreads")).toBe("spread");
    expect(lemma("opened")).toBe("open");
    expect(lemma("running")).toBe("run");
    expect(lemma("gardens")).toBe("garden");
    expect(lemma("babies")).toBe("baby");
    expect(lemma("boxes")).toBe("box");
    expect(lemma("dog")).toBe("dog");
    expect(lemma("the")).toBe("the");
  });
});

describe("키·어절 계산", () => {
  it("normalizeKey는 대소문자와 구두점을 무시한다", () => {
    expect(normalizeKey('"Be off," she cried!')).toBe(
      normalizeKey("be off she cried"),
    );
  });

  it("words는 구두점을 붙이지 않는다", () => {
    expect(words("Be off, home!")).toEqual(["Be", "off", "home"]);
  });

  it("entryKey는 레인을 포함하고 정규화 문장의 64비트 해시다", () => {
    const key = entryKey({ lane: "classic", en: "The  rabbit RAN!" });
    expect(key).toBe(entryKey({ lane: "classic", en: "the rabbit ran" }));
    expect(key.startsWith("classic:")).toBe(true);
    expect(key.length).toBeLessThan(40);
    // 64비트(R6-15): 저장소 키의 해시 조각은 16자의 16진수다.
    expect(key).toMatch(/^classic:\d+:[0-9a-f]{16}$/);
  });

  it("entryKey는 호출마다 같은 값을 준다 — seen·번역 캐시의 키다 (R6-15)", () => {
    const sentence = "There was nothing so very remarkable in that.";
    const first = entryKey({ lane: "classic", en: sentence });
    for (let i = 0; i < 5; i++) {
      expect(entryKey({ lane: "classic", en: sentence })).toBe(first);
    }
    // 앞부분이 같은 다른 문장은 다른 키를 받는다(32비트 해시는 4,400문장에서
    // 충돌 기대값 ≈ 0.2%였다 — 64비트로 넓힌 이유).
    expect(entryKey({ lane: "classic", en: sentence })).not.toBe(
      entryKey({ lane: "classic", en: `${sentence} And then it stopped.` }),
    );
  });

  it("앞부분이 같은 긴 문장도 다른 키를 준다 (120자 잘림 충돌 방지)", () => {
    const prefix = "The quick brown fox jumps over the lazy dog ".repeat(6);
    const a = entryKey({ lane: "classic", en: `${prefix}one` });
    const b = entryKey({ lane: "classic", en: `${prefix}two` });
    expect(a).not.toBe(b);
  });

  it("레인이 다르면 키가 다르다", () => {
    expect(entryKey({ lane: "daily", en: "same" })).not.toBe(
      entryKey({ lane: "classic", en: "same" }),
    );
  });
});

describe("lemma — 코퍼스 어휘를 주면 조각을 만들지 않는다", () => {
  const vocab = new Map<string, number>([
    ["anything", 30], ["surprised", 5], ["surprise", 12], ["spread", 8],
    ["spreads", 4], ["run", 20], ["ran", 15], ["he", 900],
  ]);

  it("어휘에 없는 기본형으로 줄이지 않는다", () => {
    expect(lemma("anything", vocab)).toBe("anything"); // anyth(조각) 금지
    expect(lemma("surprised", vocab)).toBe("surprise"); // surpris → surprise
    expect(lemma("spreads", vocab)).toBe("spread");
    expect(lemma("ran", vocab)).toBe("run"); // 불규칙 활용
    expect(lemma("umbrella", vocab)).toBe("umbrella"); // 후보가 없으면 표면형
  });
});

describe("pickHints — 약한 힌트를 걸러낸다", () => {
  const stats = buildFrequency([
    "The old man said anything to the boy and he ran away quickly.",
    "Nobody said anything and the boy ran away with him quickly.",
    "The old man laughed and the boy ran away quickly with him.",
  ]);

  it("대명사·부정대명사와 조각은 힌트에 들어가지 않는다", () => {
    const hints = pickHints(
      "The old man said anything to the boy and he ran away with him.",
      stats,
    );
    expect(hints).not.toContain("him");
    expect(hints).not.toContain("anything");
    expect(hints).not.toContain("anyth");
    for (const h of hints) expect(h).toMatch(/^[a-z]{2,}$/);
  });
});

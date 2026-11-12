/**
 * 한국어 텍스트에 다른 언어 문자가 섞였는지 검사하는 공통 도구.
 *
 * 번역 검사는 세 곳에서 같은 규칙을 쓴다:
 *  - scripts/check-translations.mts  : 번역 원고(줄 단위) 검사
 *  - scripts/audit-translations.mts  : 코퍼스/번역 캐시 감사
 *  - scripts/__tests__/corpus-data.test.mts : 커밋된 코퍼스 데이터 테스트
 * 규칙이 어긋나면 "한 곳은 통과하고 다른 곳은 실패"하는 애매한 상태가 생기므로 한 곳에 둔다.
 */

/**
 * 한글 판정 범위: 완성형 음절(AC00–D7A3) + 호환 자모(3130–318F) + 자모(1100–11FF).
 * 자모만 써도 한국어로 본다(키보드 오입력·분해형 표기까지 걸면 정상 문장이 오검출된다).
 */
const HANGUL = /[가-힣\u3130-\u318f\u1100-\u11ff]/;
const LETTER = /\p{L}/u;
const DIGIT = /[0-9]/;

/**
 * 기준 허용 목록 (D4-3): check · audit · 커밋 데이터 테스트가 모두 이 하나를 읽는다.
 * 사본이 흩어지면 "check는 통과하고 audit는 죽는" 불일치가 되돌아온다(R4-11/R6-12).
 * `--allow=`는 여기에 더하는 용도로 check·audit 둘 다에 남긴다.
 */
export const BASE_ALLOWED_LATIN: readonly { word: string; because: string }[] = [
  // Tatoeba 일상 회화 번역에 실제로 들어 있는 고유명사·약어 (동화 레인에서는 쓰이지 않는다)
  { word: "Tom", because: "Tatoeba 번역의 인명 'Tom'" },
  { word: "Mary", because: "Tatoeba 번역의 인명 'Mary'" },
  { word: "TV", because: "'TV를 본다'는 한국어에서 굳어진 약어" },
  { word: "DNA", because: "과학 번역에서 그대로 쓰는 약어" },
  { word: "MRI", because: "병원 검사명을 한국어 문장에 그대로 쓴다" },
  { word: "A", because: "'A 학점'·'A 형' 같은 등급/형용 표기" },
  { word: "B", because: "'B 형'·'B 열' 같은 등급/번호 표기" },
  { word: "C", because: "'C 점수' 같은 등급 표기" },
];

/** 허용 목록을 `--allow=`와 합치는 데 쓰는 Set 형태. */
export function allowedLatinSet(extra: Iterable<string> = []): Set<string> {
  const set = new Set<string>(BASE_ALLOWED_LATIN.map((entry) => entry.word));
  for (const word of extra) if (word) set.add(word);
  return set;
}

/**
 * 한글이 아닌 문자 조각을 모아 돌려준다. 허용 목록에 정확히 일치하는 조각은 넘긴다.
 * 예: "이 TV 프로그램은 재밌어요" → 허용 목록이 비면 ["TV"]
 *
 * 조각은 외국어 문자로 시작하고,뒤에 이어지는 따라오는 숫자까지 포함한다("C20"은 "C"로 잘리지 않는다).
 * 그 외 숫자·구두점·기호는 외국어로 보지 않는다. 한국어 문장에 정상적으로 들어오기 때문이다.
 */
export function foreignLetterRuns(text: string, allowed?: Set<string>): string[] {
  const runs: string[] = [];
  let current = "";
  for (const ch of text) {
    if ((LETTER.test(ch) && !HANGUL.test(ch)) || (current !== "" && DIGIT.test(ch))) {
      current += ch;
      continue;
    }
    if (current) runs.push(current);
    current = "";
  }
  if (current) runs.push(current);
  return allowed ? runs.filter((run) => !allowed.has(run)) : runs;
}

/** 한글 문자가 하나라도 있는지 (완전히 비언어적인 응답을 걸러낸다). */
export function hasHangul(text: string): boolean {
  return HANGUL.test(text);
}

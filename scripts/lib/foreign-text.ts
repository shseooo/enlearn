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

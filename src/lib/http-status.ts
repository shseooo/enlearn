/**
 * "잠시 뒤 다시 시도하면 성공할 수 있는" HTTP 상태 집합.
 *
 * 브라우저 쪽(src/lib/llm.ts)과 코퍼스 빌드 쪽(scripts/build-corpus.mts)이
 * 같은 규칙을 쓴다. 예전에는 node가 확장자 없는 import를 해석하지 못해 두 곳에
 * 복제돼 있었고, 실제로 409 한 항목이 어긋나 있었다(리뷰 2-12). 지금은 두 쪽 모두
 * .ts 확장자로 import하므로, 시크릿·브라우저 전용 값이 없는 이 판정만 공용 모듈에 둔다.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

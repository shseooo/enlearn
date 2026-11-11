/**
 * 재시도할 HTTP 상태 판정 하나를 고정한다.
 * 브라우저(llm.ts)와 코퍼스 빌드(build-corpus.mts)가 이 함수를 같이 쓰기 때문에,
 * 여기에 집합을 박아 두면 두 경로가 다시 갈라지지 않는다(리뷰 2-12).
 */
import { describe, expect, it } from "vitest";
import { isRetryableStatus } from "../http-status";

describe("isRetryableStatus", () => {
  it("시간초과·충돌·요청폭주·서버 오류는 재시도 대상으로 본다", () => {
    for (const status of [408, 409, 429, 500, 502, 503]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("잘못된 요청·인증 실패는 재시도해도 같으므로 대상이 아니다", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

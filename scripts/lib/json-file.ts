/**
 * JSON 파일을 원자적으로 읽고 쓴다.
 *
 * 번역 캐시(.corpus-cache/translations.json)와 코퍼스 산출물(public/data/corpus/*.json)
 * 는 사람이 옮긴 1,400문장이 들어 있는 자료다. 제자리에서 덮어쓰는 동안 프로세스가
 * 죽으면 파일 한 장이 통째로 깨지고, 다음 실행이 그 결과를 "번역 없음"·"완전한 원본"
 * 으로 오해한다(R3-1/R1-3/R4-1).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * 문자열·바이트 본문을 임시 파일로 썼다가 이름을 바꾼다.
 * 쓰는 도중에 멈춰도 이전 파일은 그대로다(R4-1).
 *
 * tmp 이름에 pid·uuid를 넣는 이유: 고정 이름(`${path}.tmp`)이면 두 프로세스가
 * 같은 tmp를 서로 덮고, 먼저 rename한 쪽 때문에 나머지의 renameSync가 ENOENT로
 * 터진다(`npm run corpus -- --llm`과 merge를 동시에 돌리는 경로). rename이 실패하면
 * tmp를 남기지 않는다 — 완성이 아닌 조각이 같은 자리에 굴러다니면 안 된다.
 */
export function writeAtomic(path: string, body: string | Uint8Array): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, body);
    renameSync(temp, path);
  } catch (e) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // tmp를 지울 수 없어도 원인은 이미 e에 있다 — 가려지지 않게 그대로 던진다.
    }
    throw e;
  }
}

/** JSON 값을 원자적으로 쓴다(위 `writeAtomic`의 JSON 변형). */
export function writeJsonAtomically(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value));
}

/**
 * 캐시를 읽는다. 파일이 없으면 기본값.
 * ⚠️ 파싱 실패는 조용히 기본값으로 바꾸지 않고, 손상된 사본을 `.corrupt`로
 * 남겨둔 채 오류로 끝난다. 1,400개 번역을 잃는 사고는 "왜 0건인가"로 시작한다.
 */
export function readJsonCache<T>(
  path: string,
  label: string,
  fallback: T,
): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const damaged = `${path}.corrupt`;
    renameSync(path, damaged);
    throw new Error(
      `${label}이(가) 손상되었습니다(${e instanceof Error ? e.message : e}). ` +
        `손상된 사본은 ${damaged}에 남겼습니다. 그 파일에서 회복한 뒤 다시 실행하세요.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const damaged = `${path}.corrupt`;
    renameSync(path, damaged);
    throw new Error(
      `${label} 형식이 올바르지 않습니다(객체여야 합니다). 손상된 사본은 ${damaged}에 남겼습니다.`,
    );
  }
  return parsed as T;
}

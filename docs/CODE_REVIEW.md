# EnLearn 코드 리뷰

- 리뷰 일자: 2026-11-11
- 리뷰 대상: `main` @ `1272d35` (작업 트리 clean)
- 리뷰 방식: 전체 소스 정독 + `tsc --noEmit` / `eslint` / `vitest` 실행 + 코퍼스 데이터·빌드 파이프라인 실측
- 처리 상태: 3절의 15개 항목은 **전부 처리**했다. 항목별 커밋과 검증 결과는 [6. 처리 결과](#6-처리-결과-2026-11-11-항목별-커밋)

## 1. 점검 결과 요약

| 항목 | 결과 |
| --- | --- |
| `npx tsc --noEmit` | ✅ 통과 (오류 0) |
| `npx eslint .` | ✅ 통과 (경고 0) |
| `npx vitest run` | ✅ 8 files / 110 tests 통과 (1.09s) |
| 코드 규모 | src+scripts 3,812줄 (프로덕션 2,385 / 테스트 1,427) |
| 정적 분석 커버리지 | ESLint 기본(next) 설정만 — 타입 체크는 CI 미연동 |

**전체 평가: 견고한 초안 (B+). 아키텍처·방어적 파싱·테스트 설계는 우수하지만, 동시성(비동기 경합)·URL 입력 검증·문장 선택 폴백 로직에 실제 버그가 있고, 코퍼스 난이도 등급이 데이터와 맞지 않게 캘리브레이션되어 있다.**

핵심 강점과 우선순위 이슈는 아래 2·3절.

---

## 2. 잘된 점 (유지할 것)

1. **방어적 LLM 응답 처리가 체계적이다.** `chatCompletion`(SSE/레거시 `choices[0].text`/`delta`/`reasoning_content` 폴백) + `parse.ts`(코드펜스 제거 → 중괄호 슬라이스 → 필드 정규화 → 평문 폴백) 2층 구조가 실제 이상 응답을 모두 흡수한다. 관련 테스트만 24개(llm) + 25개(parse).
2. **런타임 외부 호출이 없다.** 코퍼스를 빌드 시점에 JSON으로 확정(`public/data/corpus/*.json`)하고, 앱은 정적 파일만 읽는다. 결정론적 시드(`mulberry32`/`hashSeed`)와 `--offline` 캐시까지 갖춰 재현성이 좋다.
3. **XSS 표면이 거의 없다.** LLM 출력·코퍼스 원문을 전부 텍스트 노드로 렌더(`dangerouslySetInnerHTML` 없음). API 키가 localStorage라는 위험을 UI/README에 명시한 것도 적절.
4. **`useSyncExternalStore` 스냅샷 구현이 정확하다.** 참조 안정성(`getSettingsSnapshot` 캐시)·SSR 스냅샷·`storage` 이벤트까지 처리하고, 그 계약을 테스트로 고정(`settings.test.ts:70,92`).
5. **테스트가 구현이 아닌 행동을 본다.** LLM 경계를 `vi.mock`으로 끊고 사용 시나리오(원문 표시, 힌트 접힘, 재출제 표시)를 검증한다.
6. **라이선스 판단이 실제로 작동한다.** 『어린왕자』 제외 사유를 코드·README에 남긴 것은 흔치 않은 수준의 준수 의식.

---

## 3. 이슈

심각도: 🔴 높음(사용자 데이터/보안/오동작) · 🟠 중간(신뢰성·비용) · 🟡 낮음(품질·일관성)

### 🔴 3-1. Host에 스킴이 없으면 **API 키가 자국 도메인으로 전송**된다

`src/lib/llm.ts:23-32` `buildEndpoint()`는 절대 URL 여부를 검증하지 않는다.

```
host = "api.openai.com/v1"   (https:// 누락 — 사용자가 가장 자주 범하는 오타)
→ "api.openai.com/v1/chat/completions" 형태의 **스킴 없는 상대 경로**
→ fetch가 현재 origin 기준으로 해석:
   POST http://localhost:3000/api.openai.com/v1/chat/completions
   Authorization: Bearer sk-...
```

(실측: `new URL("api.openai.com/v1/chat/completions", "http://localhost:3000/")` → `http://localhost:3000/api.openai.com/v1/chat/completions`)

동작만 깨지는 게 아니라 **Bearer 토큰이 앱 자체 origin(프로덕션에서는 공유 호스트/미들웨어가 설 수 있는 도메인)으로 실려 간다.** `settings-tab.tsx:88`의 `type="url"`은 방어벽이 아니다 — 입력이 `<form>` 바깥에 있고 저장 버튼이 `type="button"`이어서 constraint validation이 **한 번도 실행되지 않는다.**

**조치**
```ts
export function buildEndpoint(host: string): string {
  const raw = host.trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Host를 입력해주세요.");
  let u: URL;
  try {
    // 스킴 누락은 https://로 보정해 주되, 파싱 실패/비http 스킴은 명확히 거른다
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("Host 형식이 올바르지 않습니다. 예: https://api.openai.com/v1");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("http(s) 프로토콜만 지원합니다.");
  }
  // 이후 경로 보정(/v1, /chat/completions)도 u.pathname 기준으로 — 결과 URL은 항상 절대 URL
  ...
}
```
추가로 settings-tab에 인라인 검증(`URL` 파싱 실패 시 저장 차단 + 메시지)을 넣는다.

---

### 🔴 3-2. 진행 중인 평가 응답이 새 문장 위에 덮어써진다 (경합)

`translation-tab.tsx:94` `canPick = !picking && ...` — **`loading`을 보지 않는다.** 따라서 평가 중 "📝 문장 받기"/"🔄 다시 받기"가 클릭된다.

`handleGetSentence`(139행)가 `result/evaluated`를 지운 뒤에도, 이전에 시작된 `evaluateTranslation` 프라미스가 나중에 resolve되면서

```ts
setResult({ ...r, referenceTranslation: entry.en });   // entry는 구 문장 클로저
setEvaluated({ korean, english });                     // 구 문장 클로저
```

**새 한국어 문장 위에 예전 문장의 점수·원문이 표시**된다. `follow-up` 질문 컨텍스트(`context={{original: evaluated.korean, ...}}`)도 구 문장을 가리키므로, 이후 LLM 답변이 다른 문장에 대해 달린다.

같은 파일의 코퍼스 로딩 `useEffect`(80-88행)에서는 `alive` 플래그로 이 문제를 막고 있는데, 사용자 트리거 비동기에는 적용하지 않아 **일관성도 깨져 있다.**

**조치** (둘 중 하나, 가능하면 둘 다)
- `canPick`/다시 받기 버튼에 `&& !loading` 추가,
- 요청 토큰 패턴: `const id = ++reqId.current; … if (id === reqId.current) setResult(...)`. (`AbortController`로 fetch 취소까지 묶으면 3-6도 함께 해결)

---

### 🔴 3-3. `pickEntry` 폴백이 난이도를 무시하고 "재출제"를 잘못 표시한다

`src/lib/corpus.ts:220-248`. 함수 주석은 4단계 폴백(난이도+출처·미풀음 → 난이도 완화 → 출처 전체 → 재출제)을 약속하지만 **구현은 2개 풀뿐**이다.

```ts
{ list: difficulty===X && source && unseen, recycled: false },
{ list: source만 필터,                        recycled: true },   // 난이도 무시, 무조건 recycled
```

임시 테스트로 실증한 동작:
- `difficulty:"hard"`, `sourceId:"a"`에서 hard 문장을 다 풀면 → **풀지 않은 easy 문장이 반환**된다.
- 그 문장은 본 적 없는 문장인데 `recycled:true` → UI가 `· 다 풀었다면 다시 나온 것입니다`(translation-tab.tsx:338)를 **거짓으로** 표시한다.

3-4(난이도 편중)와 겹쳐 실제 사용 시 매우 자주 발생한다: classic 레인 "쉬움"의 easy 풀은 114개뿐이라 금방 고갈되고, 그 직후 사용자는 **"쉬움"을 골랐는데 normal/hard 문장을 받으면서** 엉뚱한 재출제 안내를 본다.

**조치**
```ts
const pools = [
  { p: (e) => e.difficulty === d && src(e) && unseen(e) },
  { p: (e) => e.difficulty === d && unseen(e) },            // 출처 완화
  { p: (e) => src(e) && unseen(e) },                        // 난이도 완화
  { p: (e) => src(e) },                                     // 재출제
];
// recycled는 풀 단위가 아니라 선택 후: entryKey(entry) in seen
```
주석과 다른 폴백 순서를 고치고, 회귀 테스트 2개(난이도 완화/`recycled` 정확성)를 추가한다.

---

### 🔴 3-4. 코퍼스 난이도 등급이 데이터와 맞지 않게 캘리브레이션되어 있다

`.corpus-cache` 원본으로 재계산한 실측값:

| | 쉬움 | 보통 | 어려움 |
| --- | ---: | ---: | ---: |
| classic 후보 2,407개 | 149 (6%) | 537 (22%) | **1,721 (71%)** |
| 최종 `classics.json` 1,400개 | **114** | 405 | 881 |
| 최종 `daily.json` 3,000개 | 1,050 | 1,350 | 600 |

`balanceByDifficulty`(build-corpus.mts:451-)가 classic에 `hard 0.38` 비중을 시도해도 hard 풀이 넘치고 easy/normal 풀이 모자라, 모자란 수(349개)를 hard로 채운다. 결과적으로 **classic "쉬움" 필터는 114문장만 존재**해 3-3의 폴백과 결합해 곧바로 붕괴한다.

원인은 `GRADE_THRESHOLDS`(corpus-tools.ts:234-241)가 lane 공통 절대값이라는 점이다. 19세기 문체(긴 문장 + 희귀 어휘)는 절대값 기준에서는 무조건 hard가 된다.

**조치**: lane별 임계값 분리, 또는 `difficultyParts().score`의 **lane 내 백분위**로 분할(예: 하위 30%/중간 40%/상위 30%). classic의 `isPracticeSentence(minWords: 7)` 필터가 짧은 문장을 먼저 제거하기 때문에 easy 후보가 구조적으로 적다는 점도 함께 고려한다.

---

### 🟠 3-5. 설정 화면이 외부 변경과 동기화되지 않는다 (+ 이중 저장)

- `settings-tab.tsx:21-23`: `useState(settings)`로 초기화만 하고 이후 props와 동기화하지 않는다. 다른 탭에서 `storage` 이벤트로 스토어가 갱신돼도 입력창은 옛 값을 유지하고, **저장하면 새로운 값을 덮어쓴다**(last-write-wins, 조용한 유실).
- `page.tsx:90` + `settings-tab.tsx:37-38`: `onSaved`가 곧 `saveSettings`이므로 저장 시 **localStorage write 2회 + 변경 이벤트 2회 + React re-render 2회**가 발생한다.

**조치**: `onSaved` 시그니처를 `() => void`(또는 제거)로 줄여 저장 경로를 하나로 만든다. 입력 필드는 `dirty` 상태가 없을 때만 props를 따르도록 동기화하거나, `key={settingsVersion}`로 마운트를 갱신한다.

---

### 🟠 3-6. LLM 호출에 타임아웃/취소가 없다

`llm.ts:105-120`의 `fetch`에는 `signal`이 없다. 프로바이더가 응답을 안 보내면 스피너가 영구히 돌고, 사용자는 탭을 옮기거나 새로고침으로만 벗어날 수 있다. 같은 레포의 `build-corpus.mts`는 `AbortSignal.timeout(45_000)`을 쓴다 — **비동기 처리 기준이 두 갈래다.**

**조치**: `AbortSignal.timeout(120_000)` + "취소" 버튼(`AbortController`), 타임아웃을 별도 메시지로 구분.

### 🟠 3-7. 재시도/백오프 없음

429/5xx에 대해 `chatCompletion:127-129`가 즉시 에러를 던진다. `Retry-After` 헤더 반영, 지수 백오프 1~2회(총 대기 상한 포함)를 권장한다.

### 🟠 3-8. 추론 모델의 내부 사고 과정이 "피드백"으로 노출될 수 있다

`evaluateFreeWriting`/`evaluateTranslation`은 `max_tokens`를 보내지 않는다(llm.ts:116). 긴 reasoning을 태우는 모델은 예산을 먼저 소진해 `finish_reason:"length"` → `extractContentFromJson` 폴백 #5가 `reasoning_content`를 반환하고, 그 **내부 독백이 `parseEvaluation`의 평문 폴백을 거쳐 평가 피드백 카드에 그대로 인쇄**된다. `testConnection`에만 `maxTokens:64`를 주는 것도 불균형.

**조치**: 평가 호출에 명시적 `max_tokens`(예: 900), `reasoning_content` 폴백은 "모델이 답변을 끝내지 못했습니다. max_tokens를 늘리거나 reasoning을 줄이세요" 안내와 함께 원문을 접어 표시.

### 🟠 3-9. 추가 질문 컨텍스트가 무한히 자란다

`evaluation-card.tsx:67`이 `history` 전체를 `askFollowUp`에 넘기고, `llm.ts:348-358`이 질문+답변 전부를 프롬프트에 붙인다. 답변은 최대 수백 토큰이므로 5~6턴이면 컨텍스트와 비용이 눈에 띄게 늘고 일부 호스트는 컨텍스트 넘침으로 죽는다.

**조치**: 최근 N턴(2~3)만 포함 + 답변 발췌(예: 500자) 또는 요약. UI에는 전체 히스토리를 남긴다.

### 🟠 3-10. 에러 카드가 원시 응답/원시 JSON을 사용자에게 보여준다

- `llm.ts:127-129,154-156`: 프로바이더 본문 300자를 그대로 DOM에 인쇄. 역프록시/게이트웨이 오류에는 계정·요청 메타데이터가 실릴 수 있다.
- `parse.ts:100-112`: JSON이 **거의 맞지만** trailing comma 등으로 깨진 경우(예: `{"score":85, ...}`) 평문 폴백으로 떨어지고, `salvageScore`로 점수는 복원되면서 **feedback 칸에 raw JSON 덩어리가 출력**된다.

**조치**: 인쇄 전 `Bearer`/`sk-` 마스킹 + 개행/긴 토큰 잘라내기. 평문 폴백 전 느슨한 복구 시도(후행 쉼 제거, 닫지 못한 괄호 보정), 실패 시 "응답 형식이 올바르지 않습니다" 안내 + 원문은 `<details>`로 접기.

---

### 🟡 3-11. `splitSentences`가 O(n²) — 코퍼스 빌드가 분 단위로 느리다

`corpus-tools.ts:124`의 `tokens.slice(i + 1).find(...)`이 토큰마다 나머지 배열을 복사하므로 전체가 O(n²)이다. 실측:

| 파일 | 토큰 | 현행 | 선형 구현으로 수정 후 |
| --- | ---: | ---: | ---: |
| pg11 (앨리스) | 53,049 | 421ms | — |
| pg113 (비밀의 화원) | 161,263 | **3,358ms** | 29ms (116배) |
| pg2591 (그림 형제) | 202,221 | **5,134ms** | 42ms (122배) |

책 14권 × 평균 ~2s = **빌드 시간 대부분이 이 한 줄에서 낭비된다**(GC 포함 체감 수 분).

**조치**: 인덱스 전방 탐색으로 교체.
```ts
let next = i + 1;
while (next < tokens.length && /^\s+$/.test(tokens[next])) next++;
if (next >= tokens.length) continue;
const tok2 = tokens[next];
```
문장 분리 단위테스트로 기존 결과와 출력 동일함을 고정한다.

### 🟡 3-12. 진행 상황 초기화·번역 캐시 무효화 UI가 없다 (죽은 export)

`resetSeen` / `seenCount` / `isSeen` / `getCachedCorpus`는 **앱 코드에서 참조가 0개**(`src/lib/__tests__` 전용). 그 결과:
- 사용자는 "받은 문장" 기록을 되돌릴 방법이 없다 (README에는 "다 풀면 재출제 표시"만 안내).
- `cacheKorean`(corpus.ts:267-272)이 LLM의 엉터리/환각 번역을 영구 저장해도 **지울 수단이 없다** — classic 레인에서 실제로 눈에 띄는 결함 경로.

**조치**: 설정 탭에 "진행 기록 초기화(레인별)" + "번역 캐시 초기화" 버튼, 남은 개수 표시(`seenCount`/`sourcesOf` 활용).

### 🟡 3-13. 힌트가 답변을 그대로 흘린다 (AI 생성 경로와 동작이 불일치)

`generateKoreanExercise` 프롬프트는 "hints는 번역 결과를 그대로 드러내지 않도록"(llm.ts:263)이라 지시하지만, 코퍼스 경로의 `pickHints`(corpus-tools.ts:259-279)는 **정답 문장에서 세 단어를 그대로 뽑는다**.

```json
{ "en": "Ebola spreads from person to person through bodily fluids.",
  "hints": ["ebola","spreads","fluids"] }
{ "en": "\"I suppose they've each got 'TWEEDLE' round ...\"", "hints": ["'tweedle'","collar","they've"] }
```

한글→영문 번역 문제에서 정답 단어 3개가 미리 주어지면 평가 의미가 약해지고, `'tweedle'`·`they've` 같은 구두점 파편이 힌트로 보인다.

**조치**: 품사·빈도 기반 완화를 적용해 (a) 정답의 첫 단어·고유명사는 제외, (b) 활용형 원형 제시(`spreads → spread`), (c) 구두점 토큰 필터. 또는 의도적으로 "단어 제공형" 힌트를 UI에서 구분 표기.

### 🟡 3-14. 그 외 일관성/품질

| 위치 | 내용 |
| --- | --- |
| `corpus.ts:22-26` | `LANE_LABELS`가 미사용 — `translation-tab.tsx:40-44` `MODE_LABELS`와 레이블이 이중 정의(값이 어긋날 위험). 하나로 통합 |
| `llm.ts:190-195` | `JSON_SCHEMA.replace('"betterExpression"', ...)` 문자열 해킹. 필드를 배열로 정의하고 조립하면 스키마 변경이 안전해진다 |
| `corpus.ts:34-47` | `isCorpusFile`이 `lane`/`difficulty`/`hints` 요소 타입을 검사하지 않음 → 깨진 파일에서 난이도 필터가 조용히 전멸. `hints: unknown[]` 검증 시 `getCachedKorean`(260행)의 `string[]` 단정도 함께 보완 |
| `corpus-tools.ts:283` | `entryKey`가 120자로 잘라 긴 문장에서 충돌 가능(같은 앞부분). 해시(hash) 기반으로 바꾸면 안전 |
| `corpus-tools.ts:274` | `+ (index % 3) * 0.001 * (seed % 4)` — 빌드는 seed=0으로 호출하므로 이 지터가 **항상 0**(무의미한 코드) |
| `pickHints` slice 3 (278행) | README는 "힌트 단어 2~4개"라는데 코퍼스 경로 최대치는 3개. 문서/코드 불일치 |
| `translation-tab.tsx:214` | 출처 드롭다운 변경 시 `bookId/pickError`만 초기화 — `result/entry/korean`은 그대로. 라벨만 바뀌어 이전 결과 카드에 "📖 참고 번역" 같은 잘못된 제목이 붙는다 |
| `translation-tab.tsx:170-179` | 실패 시 `korean`만 비우고 `entry/hints/recycled`는 남겨 상태가 반쯤 낡는다 |
| `evaluation-card.tsx:100,159` | 인덱스 `key`(append-only라 현재는 무해). `CopyButton:21`의 `setTimeout`은 unmount 후 setState |
| `page.tsx:52-70` | 탭 UI에 `aria-current="page"` 사용 — `role="tablist"/"tab"/"tabpanel"` + `aria-selected` + 화살표 이동이 맞다. 로딩·오류 안내에 `role="status"`/`aria-live`가 없어 스크린리더가 진행을 모른다 |
| `settings-tab.tsx:157` | `apiKey`가 비면 연결 테스트 금지 → README가 예로 든 `http://localhost:11434/v1`(Ollama, 키 불필요)를 실제로 쓸 수 없다. `isSettingsComplete`도 apiKey를 요구하는 같은 제약 |
| `corpus.ts:192` | `dailySeed`가 `toISOString()`(UTC) → 한국 시간 09시에 "오늘의 순서"가 바뀐다 |

### 🟡 3-15. 저장소 관행

- **CI 없음** (`.github` 부재). `tsc --noEmit`과 `eslint`가 로컬에서만 돈다. PR에서 타입·린트·테스트를 돌게 하면 3-11 같은 회귀도 잡기 쉽다.
- `package.json`에 `typecheck` 스크립트 없음 (`tsc`는 에디터에만 의존).
- `npm run corpus`는 `.mts` 직접 실행(Node ≥22.6 필요)인데 `engines`가 미명시다. `scripts/build-corpus.mts` 실행 환경이 문서화되지 않았다.
- `Number(flag("per-book","180"))` → `--per-book=abc`면 `NaN`이 조용히 들어가고 `balanceByDifficulty`가 빈 결과물을 낼 수 있다(검증 추가).
- README 테스트 절: "74개 테스트" → 실제로는 **110개**, 목록에 `translation-tab.test.tsx` 누락.
- attribution: 코퍼스 JSON에 `license`/`attribution`이 담겨 있으나 앱이 표시하지 않는다. Tatoeba CC-BY 2.0 표기를 footer/about에 넣는 것이 안전하다.

---

## 4. 우선순위 실행 목록

**즉시 (1~2시간)**
1. `buildEndpoint` URL 검증 + settings 인라인 유효성 (3-1)
2. `canPick`에 `!loading` + 요청 토큰으로 stale 응답 무시 (3-2)
3. `pickEntry` 폴백 4단계 복원 + `recycled`를 항목 기준으로 계산 + 회귀 테스트 (3-3)

**이번 주**
4. classic lane 난이도 백분위 캘리브레이션 후 코퍼스 재생성 (3-4)
5. 설정 저장 경로 단일화 + 외부 변경 동기화 (3-5)
6. `AbortSignal.timeout` + 취소 버튼, 429/5xx 백오프 (3-6, 3-7)
7. 평가 호출 `max_tokens` 지정, `reasoning_content` 노출 완화 (3-8)
8. 진행 기록/번역 캐시 초기화 UI — 죽은 export를 기능으로 연결 (3-12)

**개선**
9. `splitSentences` 선형화 + 동일 출력 스냅샷 테스트 (3-11)
10. 추가 질문 컨텍스트 창 제한 (3-9), 에러 메시지 마스킹·평문 폴백 정리 (3-10)
11. 힌트 전략 재정립 (3-13), `LANE_LABELS` 통합·스키마 조립 리팩터 (3-14)
12. 탭 a11y 시맨틱, `role="status"` 추가
13. CI(tsc + eslint + vitest) + `typecheck` 스크립트 + `engines` + README 숫자 갱신

**테스트 공백 (추가 권장)**
- `free-writing-tab`, `settings-tab`(저장/테스트 플로우), `page` 셸
- `buildEndpoint`의 스킴 누락(상대 URL) 처리 — 현재는 정상적인 절대 URL 케이스만 커버된다
- `pickEntry` 난이도·출처 폴백 시맨틱, `recycled` 정확성
- follow-up 히스토리 창 제한, `markSeen`/코퍼스 동시 호출(이중 fetch 방지) 외 경합 경로

---

## 5. 부록 — 실측 데이터

```
# 정적 검증
tsc --noEmit : 통과            eslint . : 통과            vitest run : 110/110 통과 (1.09s)

# splitSentences 계산 복잡도 (corpus-tools.ts:124)
pg11   : tokens=53,049   splitSentences=421ms   → 문장 1,335
pg113  : tokens=161,263  splitSentences=3,358ms → 문장 5,659   (선형 구현: 29ms)
pg2591 : tokens=202,221  splitSentences=5,134ms → 문장 3,245   (선형 구현: 42ms)

# 코퍼스 난이도 분포
classic 후보 2,407 = easy 149 / normal 537 / hard 1,721
classics.json 1,400 = easy 114 / normal 405 / hard 881   (ko 부여됨: 0, hints 보유: 1,398)
daily.json    3,000 = easy 1,050 / normal 1,350 / hard 600
코퍼스 크기: daily.json 612KB + classics.json 308KB = 920KB (첫 문장 받기 시 클라이언트에서 파싱)

# buildEndpoint 동작 (스킴 누락)
"api.openai.com/v1" → "api.openai.com/v1/chat/completions"
  → fetch 실제 해석: POST http://localhost:3000/api.openai.com/v1/chat/completions (+ Bearer 토큰)

# pickEntry 폴백 (임시 테스트로 재현, 파일 삭제함)
difficulty=hard, sourceId=a, hard 문장 seen 처리 후
 → 반환: difficulty="easy", recycled=true  (안 푼 문장인데 "다시 나온 것"으로 표시)
```

---

## 6. 처리 결과 (2026-11-11, 항목별 커밋)

리뷰에 나온 15개 항목을 **항목별로 분리 커밋**했다. 각 커밋은 재현 가능한 회귀 테스트를 함께 담았다.

| 항목 | 커밋 | 처리 내용 |
| --- | --- | --- |
| 🔴 3-1 Host 검증 | `d3ebde9` | `checkHost()`가 절대 http(s) URL만 허용하고, 스킴 없는 값은 `https://`(localhost/`host:port`는 `http://`)로 보정 후 **origin+pathname만** 재조립한다. 설정 화면에 해석된 요청 주소/오류를 인라인 표시하고 저장도 검증 통과 시에만 가능하다. |
| 🔴 3-2 평가 경합 | `bcabcd6` | 요청 토큰(`requestSeq`)으로 늦은 응답을 버리고, `canPick`에 `!loading`·`canEvaluate`에 `!picking`을 넣어 동시 요청을 막는다. 회귀 테스트: 평가 중 두 받기 버튼 비활성. |
| 🔴 3-3 `pickEntry` 폴백 | `2509755` | 폴백 풀 대신 **순위 정렬**(난이도+출처+미풀음 → 난이도+미풀음 → 출처+미풀음 → 미풀음 전체 → 푼 문장). `recycled`는 항목별로 `entryKey(entry) in seen`로 계산. 난이도를 출처보다 먼저 완화한다. |
| 🔴 3-4 난이도 캘리브레이션 | `e12f4b7` | `computeGradeCutoffs()`로 **레인 내 백분위** 등급을 계산(고정 문턱은 폴백)하고 코퍼스를 재생성했다. classics `114/405/881 → 420/560/420`, daily `1050/1350/600 → 900/1350/750`. |
| 🟠 3-5 설정 동기화·이중 저장 | `bdddcf2` | 입력은 `edited`(편집분)만 들고 값은 props의 `settings`에서 읽는다 → 다른 탭의 저장을 따라가고 저장하지 않은 편집은 보호한다. 저장은 `onSaved` 단일 경로(localStorage 쓰기·이벤트 2중 발생 제거). 신규 `settings-tab.test.tsx`. |
| 🟠 3-6 타임아웃/취소 | `37b262b` | `AbortSignal.timeout(120s)` + `useCancellable()` 훅, 모든 탭에 **취소** 버튼. 새 요청이 이전 요청을 취소하고, 취소는 오류로 표시하지 않는다. `role="status"`/`role="alert"`로 진행·오류 발표. |
| 🟠 3-7 재시도/백오프 | `d7ddb1b` | `NetworkError`/`HttpError`로 재시도 가능 여부를 보존하고 408/409/429/5xx·연결 실패만 최대 2회 재시도. `Retry-After`(초·HTTP-date) 우선, 없으면 800ms 지수 백오프(최대 15초), 대기 중에도 취소 가능. |
| 🟠 3-8 max_tokens/추론 노출 | `f5eff26` | 평가 1200 / 짧은 JSON 700 / 추가 질문 900 기본 `max_tokens`. 추출 결과가 추론 전용이면(`chatCompletionDetailed.fromReasoning`) 독백을 보여주지 않고 안내 오류로 바꾼다. |
| 🟠 3-9 질문 컨텍스트 팽창 | `2212e11` | 요청에는 최근 3턴만, 답변은 500자로 발췌(`FOLLOW_UP_HISTORY_TURNS`/`clipText`). 화면 히스토리는 그대로 유지. |
| 🟠 3-10 원시 응답 노출 | `b95419a` | `sanitizeProviderBody()`로 `sk-*`·Bearer·api_key 등을 마스킹하고 한 줄로 축약. `repairJson()`으로 후행 쉼/잘린 괄호를 복원해 재파싱하고, 복원 실패 시 raw JSON 대신 안내 문구를 보여준다. |
| 🟡 3-11 `splitSentences` O(n²) | `ccaae71` | 후방 탐색 1회(`Int32Array nextWord`)로 선형화. 14권 34,112문장이 기존 구현과 **바이트 단위로 동일**함을 검증했고, 전체 빌드는 18초 → 0.44초. |
| 🟡 3-12 초기화 UI 없음 | `22c026e` | `clearKoreanCache()`/`koreanCacheCount()` + `useSyncExternalStore` 스냅샷. ⚙️ 설정에 **연습 기록** 섹션(회화/동화 기록·번역 캐시 수 표시, 레인별/전체 초기화). 죽어 있던 `resetSeen`·`seenCount`·`LANE_LABELS`가 실제 코드가 됐다. |
| 🟡 3-13 힌트 노출 | `36e73b7` | `lemma()`로 원형(base form)을 주고, 문장 첫 단어·고유명사(중간 대문자)·구두점/숫자 파편·축약형·stopword를 제외, 최대 4개. 빌드는 seed=0으로 호출해 항상 0이던 지터 항을 없애고, `seed`가 상위 후보 회전에 실제로 동작한다. |
| 🟡 3-14 일관성/품질 | `39f39a5` `cd2978c` `4de74e5` `aa53060` `bbb05a5` `0f1e718` `fcd3104` | `entryKey` 해시화(+저장소 v2 승격), `isCorpusFile` 항목별 검증, `getCachedKorean` 힌트 타입 검사 / 스키마 문자열 치환 제거 / 출처 변경·받기 실패 시 상태 정리 + `CopyButton` 타이머 정리 + 내용 기반 `key` / 탭 `tablist`·`tab`·`tabpanel` + 화살표 이동 + 라이선스 푸터 / API 키 선택화(`Authorization` 헤더 생략) / `dailySeed` 로컬 자정 기준 / `SettingsWarning` 공용 분리 |
| 🟡 3-15 저장소 관행 | `3d571cc` `fa0aba3` `cb53caa` `aa53060` | `npm run typecheck`·`npm run check` 추가, `engines.node >= 23.6.0`, GitHub Actions CI(typecheck→lint→test), `--lane`/`--per-book` 등 인자 검증(NaN·오타 차단), README 숫자·범위 정정, Tatoeba CC-BY / Gutenberg 표기 |

### 처리 후 검증

| 검사 | 결과 |
| --- | --- |
| `npm run typecheck` | ✅ 오류 0 |
| `npm run lint` | ✅ 오류 0 |
| `npm test` | ✅ **12 files / 174 tests** (리뷰 당시 8 files / 110 tests) |
| `npm run corpus -- --offline` | ✅ 0.46초, 결정적(다시 돌려도 `generatedAt` 외 차이 없음) |
| 코퍼스 난이도 분포 | classics 420/560/420 · daily 900/1350/750 |
| 코퍼스 스키마 | 새 `isCorpusFile` 검사로 실데이터 4,400건 위반 0건 |

### 의도적으로 남겨둔 것 (알고 선택)

- **v1 기록 초기화**: `entryKey`가 해시 기반이 되어 `enlearn.seen.v1` / `enlearn.kocache.v1`은 재사용할 수 없다. 키를 `v2`로 승격했고 기존 받은 문장 기록은 사라진다(구간 마이그레이션은 키 형식 때문에 불가능).
- **`classics.json`의 `ko`는 여전히 `null`**: 미리 번역하려면 `npm run corpus -- --llm` + LLM 환경변수가 필요하다. 런타임에 번역하고 캐시하며, 잘못된 번역은 새 초기화 UI로 지울 수 있다.
- **`lemma()`는 규칙 기반 추정**: 불규칙 동사(`ran → run`)는 처리하지 않는다. 힌트는 보조 수단이라 그대로 둔다.
- **말줄임표 뒤 문장 분리**: `splitSentences`의 기존 동작(분리하지 않음)을 골든 스냅샷 테스트로 고정만 했다. 동작 변경은 코퍼스 재생성 차이로 이어져 이번 범위에서 제외.

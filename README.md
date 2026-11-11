# 📚 EnLearn — 영어 문장 연습

AI(LLM)가 **점수(0~100) + 피드백 + 더 좋은 표현**을 제안해주는 영어 학습 웹앱입니다.

## ✨ 기능

### 1. ✍️ 자유 작성
- 영어 문장을 입력하면 LLM이 평가합니다.
- 점수 게이지, 피드백, `원래 표현 → 개선 표현` 목록, 다듬은 전체 문장을 보여줍니다.
- **💬 추가 질문**: 결과 아래에서 문법 설명·비슷한 표현·예문 등 후속 질문을 할 수 있습니다 (이전 질의응답을 컨텍스트로 함께 전송해 연속 대화 가능).

### 2. 📝 번역 연습
- **문장 출처**를 고릅니다 (기본은 코퍼스):
  - **💬 일상 회화 (Tatoeba)** — 원어민 영어 + 한국어 번역이 붙어 있는 실제 문장
  - **📖 동화 명문장 (책)** — 퍼블릭 도메인 어린이 문학의 실제 문장 (책별 선택 가능)
  - **✨ AI가 문장 만들기** — 기존 방식 (주제·난이도로 LLM이 한국어 문장 창작)
- **한 번 받은 문장은 기록되어 다시 나오지 않습니다.** (브라우저 저장, 다 풀면 재출제 표시)
  기록은 **⚙️ 설정 → 연습 기록**에서 레인별로 지울 수 있습니다.
- 문장과 함께 **영어 힌트 단어 최대 4개**가 표시되며, 화면에서는 **접힌 상태**입니다.
  힌트는 정답을 그대로 흘리지 않도록 원형(base form)으로 주고, 문장 첫 단어와
  고유명사는 제외합니다 (`pickHints`).
- 평가 결과 카드에는 LLM 번역이 아니라 **실제 출판된 영어 원문**이 표시됩니다 (`📖 명문장 (책 원문)` / `📖 원문 (Tatoeba)`).
- **💬 추가 질문**: 자유 작성과 동일하게 평가 결과에 대해 후속 질문할 수 있습니다.

#### 왜 문장을 가져와서 쓰나
LLM이 문장을 **창작**하면 한국어가 어색하고, 정답(영어)까지 LLM 산출물이라 기준이 없습니다.
그래서 **사람이 쓴 문장을 원본으로 쓰고**, LLM에는 (1) 영어→한국어 번역(동화), (2) 채점·설명만 시킵니다. 번역은 창작보다 훨씬 잘하는 작업입니다.

### 3. 📆 복습 (간격반복)
- 채점된 **코퍼스 문장이 자동으로 복습 큐**에 들어갑니다 (1 → 3 → 7 → 21 → 45일).
- 복습 화면에서는 한국어만 보여주고, **직접 쓴 뒤 정답(원문)과 비교**한 다음
  `✓ 알고 있어요 / ~ 아슬아슬 / ✗ 잊었어요`로 자기 평가합니다. 다음 복습 날짜가 달라집니다.
- **LLM을 쓰지 않으므로** API 설정이 없어도 동작하고 즉시 반응합니다.
- **연습 현황**: 연속 연습일, 오늘/이번 주 문장 수, 평균 점수, 복습 대기 수,
  **자주 틀리는 표현 상위 5개**(`원문 → 고친 표현`, 횟수).
- **주간 그래프**: 최근 8주 연습량(막대)과 평균 점수. 월요일 시작, 진행 중인 주를 진한 색으로.
- **복습 채점(선택)**: 쓴 문장을 LLM으로 채점해 점수·피드백·교정을 보여줍니다. 취소 버튼도 있습니다.
  복습 채점 점수는 연습 기록 평균에 합산되지 않습니다(연속일수·집계는 자기 평가만 셈).

### 4. ⚙️ 설정
- **Host** (예: `https://api.openai.com/v1`), **Model**, **API Key**
- 브라우저 `localStorage`에만 저장됩니다 (백엔드 없음, 서버로 전송되지 않음)
- **Host는 절대 URL로 검증**합니다. 스킴이 없는 값(`api.openai.com/v1` 같은)은
  `https://`(또는 `localhost`면 `http://`)로 보정해 저장하고, 입력창 아래에
  **실제로 요청할 주소**를 보여줍니다. 그래야 API 키가 앱 자체 도메인으로 가지 않습니다.
- **API Key는 선택**입니다. Ollama(`http://localhost:11434/v1`)처럼 키 없는
  OpenAI 호환 호스트는 키를 비우면 `Authorization` 헤더를 보내지 않습니다.
- **연결 테스트** 버튼으로 설정 확인 가능
- **연습 기록**: 받은 문장 수 / 한국어 번역 캐시 수를 보여주고 레인별로 초기화할 수 있습니다.

## 🏗️ 기술 스택

| 구분 | 기술 |
| --- | --- |
| 프레임워크 | Next.js 16 (App Router, React 19) |
| 스타일 | Tailwind CSS v4 |
| 테스트 | Vitest 5 + Testing Library (jsdom) |
| 언어 | TypeScript |

## 🔌 LLM 연동 방식

- **OpenAI 호환 `/chat/completions` API**를 사용하므로 어떤 호스트든 설정 가능합니다.
- LLM 호출은 **브라우저에서 직접 fetch**합니다. API 키는 브라우저에만 존재하지만, **CORS를 지원하는 호스트**가 필요합니다.
- **타임아웃·취소**: 모든 요청에 기본 120초 타임아웃이 걸리고, 진행 중이면
  **취소** 버튼으로 중단할 수 있습니다(취소는 오류로 표시하지 않는다).
  새 요청을 시작하면 이전 요청은 자동 취소되어 늦게 도착한 응답이 결과를
  덮어쓰지 못합니다.
- **재시도**: 연결 실패·429·5xx는 `Retry-After`를 존중해 최대 2회 재시도하고,
  400/401 같은 설정 오류는 재시도하지 않습니다.
- **max_tokens**: 평가 1200 / 짧은 JSON 생성 700 / 추가 질문 900을 기본으로 보내,
  추론(reasoning) 모델이 생각에만 예산을 쓰는 것을 줄입니다.
  답변 대신 추론 조각만 돌아오면 그 독백을 보여주지 않고 안내 메시지로 바꿉니다.
- LLM 응답은 **구조화된 JSON**으로 요구한 뒤 **방어적 파싱**을 적용합니다:
  - **API 응답 층**: 본문이 JSON이 아닌 경우(SSE 스트림, `choices[0].text` 레거시,
    추론 전용 `reasoning_content`)도 폴백 파싱. 실패 시 에러 메시지에 실제 응답
    앞부분을 표시하되, `sk-…`·Bearer 토큰 등 **시크릿은 마스킹**합니다.
  - **콘텐츠 층**: 후행 쉼·닫히지 않은 괄호처럼 **사소한 결함은 복원**해 재파싱하고,
    복원까지 실패하면 raw JSON 덩어리 대신 안내 문구를 보여줍니다
    (평문 응답에서는 `Score:`/`점수` 패턴으로 점수를 최선 추출).
  - 코드펜스 제거, JSON 앞뒤 텍스트 제거, 점수 0~100 클램핑, `corrections` 키 정규화.
- Host 정규화: `https://api.openai.com` → `.../v1/chat/completions`, `.../v1/` → trailing slash 제거 등 자동 처리.

## 📚 코퍼스 (연습 문장 데이터)

한 번 내려받아 정제된 JSON으로 저장합니다. 앱은 이 파일만 쓰므로 **런타임에 외부 사이트로 요청을 보내지 않습니다**.

```bash
npm run corpus                     # 두 레인 모두 (원본은 .corpus-cache/ 에 캐시)
npm run corpus -- --lane=daily     # 일상 회화만
npm run corpus -- --offline       # 내려받지 않고 캐시로 정제만
npm run corpus -- --llm           # 동화 문장에 한국어 번역/힌트를 미리 입힘
```

`--llm`에는 `ENLEARN_LLM_HOST`, `ENLEARN_LLM_MODEL` 가 필요합니다(`ENLEARN_LLM_API_KEY`는 키 없는
로컬 호스트라면 비워도 됩니다). 건너뛰면 앱이 첫 대면 LLM으로 한국어를 옮겨 브라우저에 캐시합니다.

번역은 **배치로** 돕니다 — 한 요청에 10문장씩(기본), 동시 3개까지. 1,400문장이면 요청은 140개입니다.

```bash
npm run corpus -- --llm --batch=12 --concurrency=2   # 요청 단위·동시성 조절
```

- `.corpus-cache/translations.json`에 번역을 저장하므로 **중단해도 다시 실행하면 이어서** 합니다(같은 문장 재요청 없음).
- 실제 파일에 들어갈 문장만 번역합니다(밸런싱 후). 후보 2,407개 중 수록은 1,400개라 요청이 그만큼 줄어듭니다.
- 응답이 이상하면(번호 어긋남·환각 문장·한국어 아님) 그 항목은 버리고 다음으로 넘어갑니다. 파싱은 `src/lib/parse-batch.ts`.

| 레인 | 출처 | 라이선스 | 기본 수록 |
| --- | --- | --- | --- |
| 💬 일상 회화 | Tatoeba (manythings.org/anki `kor-eng.zip`) | CC-BY 2.0 (France) — 문장 id는 각 항목 `sourceId` | 3,000문장 |
| 📖 동화 명문장 | Project Gutenberg: 앨리스, 거울을 통한 이상한 나라의 앨리스, 피터팬, 오즈의 마법사, 비밀의 화원, 버드나무를 타고, 피노키오, 벨벳 토끼, 이솝우화(2종), 안데르센, 그림 형제, 한국 요정 이야기, 한국 옛날 이야기 | 퍼블릭 도메인 | 1,400문장 (책당 180개 제한) |

> ⚠️ **『어린왕자』는 제외했습니다.** 1943년 미국 출판본이라 미국 기준 저작권이 남아 있어 파일을 함께 넣을 수 없습니다. 같은 결의 『벨벳 토끼』『버드나무를 타고』로 대체했습니다.

난이도와 힌트는 **LLM 없이 규칙으로** 계산합니다 (`src/lib/corpus-tools.ts`): 어휘 빈도로 희귀 어휘 수·어절 수·절 수를 점수로 매긴 뒤, **레인 안의 백분위**로 쉬움/보통/어려움을 나눕니다. (고정 문턱만 쓰면 19세기 문체가 전부 "어려움"으로 분류되어 코퍼스 1,400개 중 쉬움이 114개뿐이었습니다.) 비율은 `--classic-cap`, `--daily-cap`, `--per-book`으로 조정합니다.

## 🚀 실행

Node **23.6 이상**이 필요합니다 — `scripts/build-corpus.mts`가 `.mts` 파일과 `.ts`
확장자 import, 즉 Node의 타입 스트리핑에 의존합니다.

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:3000)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm run check      # typecheck + lint + test 한 번에
```

## ✅ 테스트

```bash
npm test           # vitest run (318개 테스트 / 23개 파일)
npm run test:watch # watch 모드
```

테스트 범위:

- `src/lib/__tests__/parse.test.ts` — 방어적 JSON 파싱 + 부러진 JSON 복원 + 평문 응답 폴백
- `src/lib/__tests__/llm.test.ts` — 요청/응답 처리, SSE·레거시·추론 폴백, Host 검증, 타임아웃/취소, 429·5xx 재시도, 시크릿 마스킹
- `src/lib/__tests__/settings.test.ts` — localStorage 설정 로드/저장, 외부 스토어 스냅샷
- `src/lib/__tests__/corpus-tools.test.ts` — 상여 제거, 약어·따옴표 고려 문장 분리(선형 시간), 연습 문장 필터, 백분위 난이도, lemma 힌트
- `src/lib/__tests__/corpus.test.ts` — 코퍼스 검증, 4단계 문장 선택, 푼 기록/재출제, 번역 캐시 초기화, 일일 시드, 백업 병합
- `src/lib/__tests__/practice.test.ts` — 연습 기록 상한/갱신, 연속 연습일, 이번 주 집계, 자주 틀린 표현, SRS 단계·복습 날짜, 주간 집계, 백업 복원 검증, 스냅샷 참조 안정성
- `src/lib/__tests__/parse-batch.test.ts` — 배치 번역 응답 파싱(번호·원문 대조·환각 항목·성의 없는 번역)
- `src/lib/__tests__/backup.test.ts` — 백업 생성(API 키 미포함), 파일 검증, 합치기/대체, 왕복
- `src/components/__tests__/backup-card.test.tsx` — 내보내기, 가져오기 미리보기, 합치기/대체/취소, 오류
- `src/components/__tests__/translation-tab.test.tsx` — 코퍼스 플로우, 경합·취소, 출처 변경 시 상태 정리
- `src/components/__tests__/free-writing-tab.test.tsx` — 평가 플로우, 취소 버튼, 오류 표시
- `src/components/__tests__/evaluation-card.test.tsx` — 결과 렌더링, 추가 질문 요청
- `src/components/__tests__/settings-tab.test.tsx` — 저장 단일화, 외부 변경 동기화, Host 검증, 키 없는 호스트
- `src/components/__tests__/progress-reset.test.tsx` — 연습 기록·번역 캐시·복습 큐 초기화
- `src/components/__tests__/review-tab.test.tsx` — 복습 플로우(정답 보기·평점·다음 문장), 놓친 횟수, 현황 카드, LLM 채점·취소·실패, 주간 그래프
- `src/components/__tests__/score-gauge.test.tsx` — 점수 색상·평가 문구
- `src/components/__tests__/weekly-chart.test.tsx` — 빈 주 렌더링, 막대 정규화, 접근 가능한 설명
- `src/components/__tests__/storage-warning` / `src/lib/__tests__/storage.test.ts` — 저장 공간 초과 처리
- `src/lib/__tests__/json.test.ts` — 이스케이프된 따옴표·잘린 JSON·무효한 이스케이프 복원
- `src/lib/__tests__/use-cancellable.test.ts` — `cancel()` 후 `isCurrent()` 계약, 새 호출 대체
- `src/app/__tests__/error.test.tsx` — 오류 바운더리(다시 시도)
- `scripts/__tests__/build-corpus.test.mts` — 재시도 분류, 난이도 배분 비율·상한, 같은 seed 재현
- `src/app/__tests__/page.test.tsx` — 탭 시맨틱(tablist/tab/tabpanel), 입력 유지, 출처 라이선스 표기

## 🔄 백업 / 복구

서버가 없어서 기록은 전부 브라우저에 있습니다. 브라우저가 초기화되거나 기기를 바꾸면
연속 연습일·복습 큐가 사라지므로, ⚙️ 설정 탭의 **백업 · 복구**로 JSON 한 장으로 옮깁니다.

- **내보내기**: `enlearn-backup-YYYY-MM-DD.json` (연습 기록 · 복습 큐 · 받은 문장 기록 · 번역 캐시)
- **가져오기**: 파일을 고르면 내용을 미리 보여주고 **합치기** 또는 **대체**(확인 후)로 반영합니다.
  형식이 다른 파일은 한국어 메시지로 거절하고, 오래된/먼저 모르는 항목은 조용히 건너뜁니다.
  복원 개수는 "실제로 저장된 개수"를 알려줍니다(상한으로 잘린 경우 포함).
- ⚠️ **API 키는 백업에 넣지 않습니다.** 호스트·모델 이름만 넣습니다. 키는 직접 다시 입력하세요.
- 백업에 들어 있는 연결 설정(host/model)은 **기본적으로 되돌리지 않습니다**. "연결 설정도 되돌리기"를
  직접 켜야 적용되고, 그 경우에도 저장은 `checkHost`를 통과한 값만 반영되며(http 원격 호스트는
  경고와 함께 표시) 지금의 API 키는 그대로 그 도메인으로 전송됩니다.
- 저장 코드: `src/lib/backup.ts` (형식 검증 · 병합 규칙)

## 💾 브라우저에 저장되는 것 (서버 없음)

| 키 | 내용 | 초기화 |
| --- | --- | --- |
| `enlearn.settings` | LLM host / model / apiKey | 설정 화면 |
| `enlearn.seen.v2` | 받은 문장 기록 (같은 문장 재출제 방지) | ⚙️ 연습 기록 → 레인별 지우기 |
| `enlearn.kocache.v2` | 동화 문장의 AI 한국어 번역 (문장당 1회) | ⚙️ 한국어 번역 캐시 지우기 |
| `enlearn.log.v1` | 연습 기록: 점수·내 답·교정 (최대 400건) | ⚙️ 연습 기록 지우기 |
| `enlearn.srs.v1` | 간격반복 큐: 단계·다음 복습 날짜·놓친 횟수 (최대 500건, 낮은 단계부터 밀려남) | ⚙️ 복습 큐 비우기 |

저장소 상한(`enlearn.seen.v2` 20,000 / `enlearn.kocache.v2` 4,000)을 두어 브라우저 용량(~5MB)을
넘기지 않게 한다. 쓰기가 실패해도(QuotaExceededError) 화면은 멈추지 않고, 이전 값이 그대로
남으며, 복습 탭과 백업 카드에 `⚠️ 브라우저 저장 공간이 가득 찼습니다` 안내가 뜬다.

## 📁 구조

```
src/
├── app/
│   ├── layout.tsx          # 루트 레이아웃 + 메타데이터
│   ├── page.tsx            # 탭 셸 (useSyncExternalStore로 설정 구독)
│   └── globals.css         # Tailwind v4 (CSS-first)
├── components/
│   ├── free-writing-tab.tsx    # ✍️ 자유 작성
│   ├── translation-tab.tsx     # 📝 번역 연습 (코퍼스 / AI 생성)
│   ├── review-tab.tsx          # 📆 복습 (간격반복) + 연습 현황 + LLM 채점
│   ├── weekly-chart.tsx        # 주간 연습량 막대 그래프
│   ├── backup-card.tsx         # ⚙️ 백업 내보내기 / 가져오기 (합치기·대체)
│   ├── settings-tab.tsx        # ⚙️ 설정 + 연결 테스트 + 연습 기록 초기화
│   ├── progress-reset.tsx      # 연습 기록·한국어 번역 캐시 표시/초기화
│   ├── settings-warning.tsx    # LLM 설정 안내 배너 (탭 공통)
│   ├── evaluation-card.tsx     # 점수/피드백/개선안 공통 결과 카드 (원문 표기 포함)
│   └── score-gauge.tsx         # SVG 원형 점수 게이지
├── lib/
│   ├── llm.ts              # OpenAI 호환 API 클라이언트 + 프롬프트
│   ├── corpus.ts           # 코퍼스 로딩/문장 선택/푼 기록/한국어 번역 캐시
│   ├── corpus-tools.ts     # 원문 정제·문장 분리·난이도·힌트 (순수 함수)
│   ├── practice.ts         # 연습 기록 · 연속일수/통계 · 주간 집계 · 간격반복(SRS) 큐
│   ├── backup.ts           # 연습 기록 백업/복원 (API 키는 담지 않는다)
│   ├── json.ts             # LLM 응답에서 JSON 꺼내기(복원 포함)
│   ├── parse-batch.ts      # 배치 번역 응답 파싱 (빌드 스크립트가 node로 사용)
│   ├── parse.ts                # LLM 응답 방어적 JSON 파싱
│   ├── settings.ts             # localStorage 설정 + 외부 스토어 구독
│   ├── use-cancellable.ts      # 진행 중인 LLM 요청 취소/교차 방지 훅
│   └── types.ts                # 공용 타입 (코퍼스 타입 포함)

scripts/
└── build-corpus.mts      # 내려받기·정제·난이도/힌트 → public/data/corpus/*.json

public/data/corpus/
├── daily.json            # 💬 일상 회화 (Tatoeba)
└── classics.json         # 📖 동화 명문장 (퍼블릭 도메인)
```

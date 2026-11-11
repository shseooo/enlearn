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
- 문장과 함께 **영어 힌트 단어 2~4개**가 표시되며, 화면에서는 **접힌 상태**입니다.
- 평가 결과 카드에는 LLM 번역이 아니라 **실제 출판된 영어 원문**이 표시됩니다 (`📖 명문장 (책 원문)` / `📖 원문 (Tatoeba)`).
- **💬 추가 질문**: 자유 작성과 동일하게 평가 결과에 대해 후속 질문할 수 있습니다.

#### 왜 문장을 가져와서 쓰나
LLM이 문장을 **창작**하면 한국어가 어색하고, 정답(영어)까지 LLM 산출물이라 기준이 없습니다.
그래서 **사람이 쓴 문장을 원본으로 쓰고**, LLM에는 (1) 영어→한국어 번역(동화), (2) 채점·설명만 시킵니다. 번역은 창작보다 훨씬 잘하는 작업입니다.

### 3. ⚙️ 설정
- **Host** (예: `https://api.openai.com/v1`), **Model**, **API Key**
- 브라우저 `localStorage`에만 저장됩니다 (백엔드 없음, 서버로 전송되지 않음)
- **연결 테스트** 버튼으로 설정 확인 가능

## 🏗️ 기술 스택

| 구분 | 기술 |
| --- | --- |
| 프레임워크 | Next.js 16 (App Router, React 19) |
| 스타일 | Tailwind CSS v4 |
| 테스트 | Vitest 5 + Testing Library (jsdom) |
| 언어 | TypeScript |

## 🔌 LLM 연동 방식

- **OpenAI 호환 `/chat/completions` API**를 사용하므로 어떤 호스트든 설정 가능합니다.
- LLM 응답은 **구조화된 JSON**으로 요구한 뒤 **2층 방어적 파싱**을 적용합니다:
  - **API 응답 층**: 본문이 JSON이 아닌 경우(예: SSE 스트림, `choices[0].text` 레거시 형식)도 폴백 파싱. 실패 시 에러 메시지에 **실제 응답 앞부분(300자)을 표시**해 원인을 바로 파악할 수 있습니다.
  - **콘텐츠 층**: 모델이 JSON 지시를 무시하고 평문으로 답해도 에러 대신, 원문을 feedback으로 살리고 `Score:`/`점수` 같은 패턴에서 점수를 최선 추출합니다.
  - JSON 파싱 시 코드펜스 제거, JSON 앞뒤 텍스트 제거, 점수 0~100 클램핑, `corrections` 배열의 다양한 키/형식 정규화.
- LLM 호출은 **브라우저에서 직접 fetch**합니다. API 키는 브라우저에만 존재하지만, **CORS를 지원하는 호스트**가 필요합니다.
- Host 정규화: `https://api.openai.com` → `.../v1/chat/completions`, `.../v1/` → trailing slash 제거 등 자동 처리.

## 📚 코퍼스 (연습 문장 데이터)

한 번 내려받아 정제된 JSON으로 저장합니다. 앱은 이 파일만 쓰므로 **런타임에 외부 사이트로 요청을 보내지 않습니다**.

```bash
npm run corpus                     # 두 레인 모두 (원본은 .corpus-cache/ 에 캐시)
npm run corpus -- --lane=daily     # 일상 회화만
npm run corpus -- --offline       # 내려받지 않고 캐시로 정제만
npm run corpus -- --llm           # 동화 문장에 한국어 번역/힌트를 미리 입힘
```

`--llm`에는 `ENLEARN_LLM_HOST`, `ENLEARN_LLM_MODEL`, `ENLEARN_LLM_API_KEY` 가 필요합니다.
건너뛰면 앱이 첫 문장만 LLM으로 한국어 번역을 만들고 브라우저에 캐시합니다.

| 레인 | 출처 | 라이선스 | 기본 수록 |
| --- | --- | --- | --- |
| 💬 일상 회화 | Tatoeba (manythings.org/anki `kor-eng.zip`) | CC-BY 2.0 (France) — 문장 id는 각 항목 `sourceId` | 3,000문장 |
| 📖 동화 명문장 | Project Gutenberg: 앨리스, 거울을 통한 이상한 나라의 앨리스, 피터팬, 오즈의 마법사, 비밀의 화원, 버드나무를 타고, 피노키오, 벨벳 토끼, 이솝우화(2종), 안데르센, 그림 형제, 한국 요정 이야기, 한국 옛날 이야기 | 퍼블릭 도메인 | 1,400문장 (책당 180개 제한) |

> ⚠️ **『어린왕자』는 제외했습니다.** 1943년 미국 출판본이라 미국 기준 저작권이 남아 있어 파일을 함께 넣을 수 없습니다. 같은 결의 『벨벳 토끼』『버드나무를 타고』로 대체했습니다.

난이도와 힌트는 **LLM 없이 규칙으로** 계산합니다 (`src/lib/corpus-tools.ts`): 코퍼스 전체 어휘 빈도로 희귀 어휘 수·어절 수·절 수를 봅니다. 비율이 마음에 들지 않으면 `GRADE_THRESHOLDS`, `--classic-cap`, `--daily-cap`, `--per-book`으로 조정합니다.

## 🚀 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:3000)
```

## ✅ 테스트

```bash
npm test           # vitest run (74개 테스트)
npm run test:watch # watch 모드
```

테스트 범위:

- `src/lib/__tests__/parse.test.ts` — LLM 응답 방어적 JSON 파싱 + 평문 응답 폴백
- `src/lib/__tests__/llm.test.ts` — OpenAI 호환 요청/응답 처리, SSE 스트림/레거시 형식 폴백, 오류 케이스 (fetch mock)
- `src/lib/__tests__/settings.test.ts` — localStorage 설정 로드/저장, useSyncExternalStore 스냅샷
- `src/lib/__tests__/corpus-tools.test.ts` — Gutenberg 상여 제거, 약어·따옴표·말줄임표 고려 문장 분리, 연습 문장 필터, 규칙 기반 난이도/힌트
- `src/lib/__tests__/corpus.test.ts` — 코퍼스 로딩 오류 메시지, 안 푼 문장 우선 선택, 푼 기록과 재출제, 한국어 번역 캐시
- `src/components/__tests__/*` — 점수 게이지, 평가 카드 렌더링

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
│   ├── settings-tab.tsx        # ⚙️ 설정 + 연결 테스트
│   ├── evaluation-card.tsx     # 점수/피드백/개선안 공통 결과 카드 (원문 표기 포함)
│   └── score-gauge.tsx         # SVG 원형 점수 게이지
├── lib/
│   ├── llm.ts              # OpenAI 호환 API 클라이언트 + 프롬프트
│   ├── corpus.ts           # 코퍼스 로딩/문장 선택/푼 기록/한국어 번역 캐시
│   ├── corpus-tools.ts     # 원문 정제·문장 분리·난이도·힌트 (순수 함수)
│   ├── parse.ts                # LLM 응답 방어적 JSON 파싱
│   ├── settings.ts             # localStorage 설정 + 외부 스토어 구독
│   └── types.ts                # 공용 타입 (코퍼스 타입 포함)

scripts/
└── build-corpus.mts      # 내려받기·정제·난이도/힌트 → public/data/corpus/*.json

public/data/corpus/
├── daily.json            # 💬 일상 회화 (Tatoeba)
└── classics.json         # 📖 동화 명문장 (퍼블릭 도메인)
```

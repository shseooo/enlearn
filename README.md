# 📚 EnLearn — 영어 문장 연습

AI(LLM)가 **점수(0~100) + 피드백 + 더 좋은 표현**을 제안해주는 영어 학습 웹앱입니다.

## ✨ 기능

### 1. ✍️ 자유 작성
- 영어 문장을 입력하면 LLM이 평가합니다.
- 점수 게이지, 피드백, `원래 표현 → 개선 표현` 목록, 다듬은 전체 문장을 보여줍니다.

### 2. 📝 번역 연습
- **주제 입력** (선택) + 난이도(쉬움/보통/어려움)를 지정해 LLM이 **한국어 문장**을 만들어줍니다.
- 문장과 함께 **영어 힌트 단어 2~4개**가 생성되며, 화면에서는 **접힌 상태**로 표시되고 펼쳤을 때만 확인할 수 있습니다.
- 사용자가 영어로 번역하면 점수 + **참고 번역** + 피드백 + 더 좋은 표현을 받습니다.

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

## 🚀 실행

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:3000)
```

## ✅ 테스트

```bash
npm test           # vitest run (45개 테스트)
npm run test:watch # watch 모드
```

테스트 범위:

- `src/lib/__tests__/parse.test.ts` — LLM 응답 방어적 JSON 파싱 + 평문 응답 폴백
- `src/lib/__tests__/llm.test.ts` — OpenAI 호환 요청/응답 처리, SSE 스트림/레거시 형식 폴백, 오류 케이스 (fetch mock)
- `src/lib/__tests__/settings.test.ts` — localStorage 설정 로드/저장, useSyncExternalStore 스냅샷
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
│   ├── translation-tab.tsx     # 📝 번역 연습
│   ├── settings-tab.tsx        # ⚙️ 설정 + 연결 테스트
│   ├── evaluation-card.tsx     # 점수/피드백/개선안 공통 결과 카드
│   └── score-gauge.tsx         # SVG 원형 점수 게이지
└── lib/
    ├── llm.ts              # OpenAI 호환 API 클라이언트 + 프롬프트
    ├── parse.ts            # LLM 응답 방어적 JSON 파싱
    ├── settings.ts         # localStorage 설정 + 외부 스토어 구독
    └── types.ts            # 공용 타입
```

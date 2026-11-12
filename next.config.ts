import type { NextConfig } from "next";

/*
 * Content-Security-Policy (resolved.md에서 정한 기준값).
 * 이 앱은 서버가 없고 API 키를 브라우저에 두지 않는다(localStorage).
 *
 * connect-src가 넓은 이유: 사용자가 넣은 LLM 주소(로컬 Ollama 등)로 브라우저가
 * 직접 Authorization: Bearer <key>를 보낸다(src/lib/llm.ts, host는 src/lib/host.ts가
 * 검사). 인젝션이 생기면 키 탈취가 가장 큰 피해이고, 같은 앱이 임의 host를
 * 못 쓰게 막으면 설정 기능이 동작하지 않는다.
 *
 * dev만 완화한 조각이 하나 있다(HMR의 ws://) — 아래 connectSrc에서 표시한다.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

const CONNECT_SRC = [
  "'self'",
  "https:",
  "http://localhost:*",
  "http://127.0.0.1:*",
  // `next dev`의 핫 리로더는 ws://localhost로 붙는다(node_modules/next/dist/client/
  // dev/hot-reloader/app/web-socket.js). 이 줄이 없으면 dev에서 HMR이 CSP에 막힌다.
  // 프로덕션에는 ws 연결이 없다 — resolved.md가 허용한 "dev만 완화"다.
  ...(IS_PRODUCTION ? [] : ["ws://localhost:*", "ws://127.0.0.1:*"]),
].join(" ");

const CSP = [
  "default-src 'self'",
  // Next의 인라인 스크립트·스타일(진입 번들·CSS) 때문이다.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  // next/font/google는 빌드 때 폰트를 내려받아 같은 출처(/_next/static)에서 제공한다.
  "font-src 'self'",
  `connect-src ${CONNECT_SRC}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // 이 앱은 서버가 없고 API 키를 브라우저에 두지 않는다(localStorage).
  // 그래도 기본 방어선은 걸어 둔다. (CDN/Pages로 올리면 그쪽 헤더 설정도 별도로 필요하다)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: CSP,
          },
        ],
      },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

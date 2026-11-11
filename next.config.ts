import type { NextConfig } from "next";

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

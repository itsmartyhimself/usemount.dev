import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The preview iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
  // (Step 4.3 hardening) → its origin is the opaque string `null`. The iframe's
  // ES-module imports of the self-hosted React runtime (importmap →
  // /preview-runtime/*.mjs, see lib/preview/iframe-html.ts) are therefore
  // CROSS-origin and require CORS — even though the files are same-host. Without
  // this header the browser blocks them, React never loads, nothing mounts, and
  // the canvas stays blank. These are non-secret public runtime bundles, so `*`
  // is correct and sufficient (simple GET module fetch: no preflight, no creds).
  async headers() {
    return [
      {
        source: "/preview-runtime/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;

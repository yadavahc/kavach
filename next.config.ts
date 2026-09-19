import type { NextConfig } from "next";

/**
 * /live and /bench run the retrieval runtime and are served cross-origin
 * isolated: 5µs timer resolution for honest latency numbers, and threads for
 * ONNX Runtime. The worker bundle and its binary assets carry the same policy.
 */
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/live", headers: isolation },
      { source: "/bench", headers: isolation },
      { source: "/vendor/:path*", headers: [...isolation, { key: "Cross-Origin-Resource-Policy", value: "same-origin" }, { key: "Cache-Control", value: "public, max-age=3600" }] },
      { source: "/data/:path*", headers: [...isolation, { key: "Cross-Origin-Resource-Policy", value: "same-origin" }] },
    ];
  },
};

export default nextConfig;

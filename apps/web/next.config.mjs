import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin the workspace root so Next doesn't auto-detect a stray
  // package-lock.json elsewhere on the developer's machine — the
  // resulting wrong file-tracing root produces opaque
  // "module not found" failures on Vercel.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  // Vercel inflates every serverless function with the union of all
  // files traced from its entry point. ``@huggingface/transformers``
  // declares ``onnxruntime-node`` (404 MB of native binaries for every
  // arch) as a server-side fallback, which we never call — but the
  // trace pulls it in and blows the 250 MB function ceiling on every
  // dynamic route. Excluding the files from the trace keeps the
  // package available at install time (in case some browser-side path
  // touches its types) while keeping the deployed function tiny.
  outputFileTracingExcludes: {
    '*': [
      'node_modules/onnxruntime-node/**',
      'node_modules/.pnpm/onnxruntime-node*/**',
      'node_modules/@huggingface/transformers/node_modules/onnxruntime-node/**',
      'node_modules/@mlc-ai/web-llm/dist/**',
      'node_modules/.pnpm/@mlc-ai+web-llm*/node_modules/@mlc-ai/web-llm/dist/**',
      'node_modules/@img/**',
      'node_modules/.pnpm/@img+**',
    ],
  },
  // Workspace packages live as raw .ts/.tsx (no build step). Next must
  // transpile each one we import; a missing entry produces
  // "Module parse failed: Unexpected token" at build time.
  transpilePackages: [
    '@studyforge/ui',
    '@studyforge/shared-types',
    '@studyforge/webllm-client',
  ],
  // Heavy client-only browser ML libs. Keeping them out of the server
  // bundle avoids "globalThis is not defined" / WebGPU import errors
  // when Next tries to evaluate them during SSR.
  serverExternalPackages: [
    '@huggingface/transformers',
    '@mlc-ai/web-llm',
  ],
  experimental: {
    // ``serverActions`` moved under ``experimental`` for granular options
    // in Next 14+; the top-level form is invalid in 15.
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  // Same-origin proxy so the browser never sees a cross-origin API call.
  // Cross-site cookies are blocked by default in Safari (ITP) and by Chrome
  // when third-party cookies are off, even with SameSite=None; Secure.
  // Routing every API call through ``vercel.app/v1/*`` makes ``sf_session``
  // a first-party cookie on the FE domain and works in every browser.
  //
  // Requires:
  //   • ``NEXT_PUBLIC_API_BASE_URL`` set to the real Render API URL
  //   • Google OAuth Authorized Redirect URI set to the Vercel domain
  //     (the API ``GOOGLE_CALLBACK_URL`` env var follows the same value)
  async rewrites() {
    const apiBase = process.env['NEXT_PUBLIC_API_BASE_URL'];
    if (!apiBase) return [];
    return [
      { source: '/v1/:path*', destination: `${apiBase}/v1/:path*` },
      { source: '/health', destination: `${apiBase}/health` },
      { source: '/docs', destination: `${apiBase}/docs` },
      { source: '/docs/:path*', destination: `${apiBase}/docs/:path*` },
    ];
  },
};

export default nextConfig;

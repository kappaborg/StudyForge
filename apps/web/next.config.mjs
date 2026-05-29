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
};

export default nextConfig;

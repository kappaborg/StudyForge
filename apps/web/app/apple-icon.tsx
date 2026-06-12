import { ImageResponse } from 'next/og';

// iOS Safari uses the apple-touch-icon as the home-screen icon when the
// user picks "Add to Home Screen". 180×180 is the canonical size; iOS
// downsamples for the smaller targets. Generated at request time via
// next/og so we don't need an external rasterizer in the toolchain.

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#ffffff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontWeight: 800,
          fontSize: 96,
          letterSpacing: -4,
        }}
      >
        SF
      </div>
    ),
    { ...size },
  );
}

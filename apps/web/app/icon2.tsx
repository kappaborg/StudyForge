import { ImageResponse } from 'next/og';

// 512×512 PNG — manifest requires at least one icon ≥ 512 to qualify for
// the install banner on Chrome / Android. Also used for the splash
// screen on first launch.

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon512() {
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
          fontSize: 280,
          letterSpacing: -10,
        }}
      >
        SF
      </div>
    ),
    { ...size },
  );
}

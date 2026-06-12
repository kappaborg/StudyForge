import { ImageResponse } from 'next/og';

// 192×192 PNG for the web app manifest. Android + Chrome desktop pick
// this for the install banner and home-screen icon.

export const size = { width: 192, height: 192 };
export const contentType = 'image/png';

export default function Icon192() {
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
          fontSize: 104,
          letterSpacing: -4,
        }}
      >
        SF
      </div>
    ),
    { ...size },
  );
}

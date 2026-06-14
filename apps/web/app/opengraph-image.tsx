import { ImageResponse } from 'next/og';

// 1200×630 social card. Next.js picks this file up automatically and
// emits ``<meta property="og:image">`` + ``<meta name="twitter:image">``
// pointing at it. When the StudyForge URL gets shared in Slack /
// Discord / iMessage / Twitter, this is the thumbnail.

export const alt = 'StudyForge AI — free, cited AI tutor for your course materials';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          background:
            'linear-gradient(135deg, #0a0a0a 0%, #111 60%, #1a1a1a 100%)',
          color: '#ffffff',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 24,
          }}
        >
          <div
            style={{
              width: 92,
              height: 92,
              borderRadius: 20,
              background: '#ffffff',
              color: '#0a0a0a',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 56,
              fontWeight: 800,
              letterSpacing: -2,
            }}
          >
            SF
          </div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 600,
              letterSpacing: -1,
            }}
          >
            StudyForge AI
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <div
            style={{
              fontSize: 78,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.05,
              maxWidth: 980,
            }}
          >
            Your course. Your tutor. Your roadmap.
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 400,
              color: '#9ca3af',
              maxWidth: 900,
            }}
          >
            Upload lectures, slides, notebooks. Get a personalised, cited AI
            tutor — free for students.
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 22,
            color: '#6b7280',
          }}
        >
          <div>study-forge-web.vercel.app</div>
          <div
            style={{
              padding: '8px 16px',
              border: '1px solid #374151',
              borderRadius: 6,
              fontSize: 20,
              color: '#9ca3af',
            }}
          >
            Free for every student
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}

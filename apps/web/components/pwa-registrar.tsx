'use client';

import { useEffect, useState } from 'react';

export function PwaRegistrar() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // Don't register a SW in dev — Next's HMR uses websockets and
    // intercepted fetches confuse the dev server. Production-only.
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .catch((err) => console.warn('sw registration failed', err));
    }
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 backdrop-blur"
    >
      Offline — viewing cached decks + roadmap
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { hasWebGPU } from '@studyforge/webllm-client';
import { loadMeta } from './local-models-db';
import { useAuth } from '../components/auth-gate';

export interface OfflineTutorAvailability {
  /** ``true`` once we've finished both the WebGPU probe and the index lookup. */
  ready: boolean;
  /** Browser supports WebGPU and the adapter handshake succeeded. */
  supported: boolean;
  /** A local index has been built for this folder + user. */
  hasIndex: boolean;
  /** Net signal — the offline tutor will work right now. */
  available: boolean;
  /** ``true`` when the browser currently reports offline. Lets the UI
   *  *promote* the offline tutor (vs just *offer* it) when the network
   *  is genuinely down. */
  isOffline: boolean;
}

/**
 * Capability + index probe for the WebLLM-driven local tutor.
 *
 * Cheap to call — the WebGPU adapter check is async but takes one
 * frame; the IDB read is microtask-fast. We re-run when ``folderId``
 * or the auth context changes so a freshly-built index becomes
 * discoverable without a page reload.
 *
 * Network-state tracking is opt-in via the ``online``/``offline``
 * events; the initial value comes from ``navigator.onLine``.
 */
export function useOfflineTutorReady(folderId: string | undefined | null): OfflineTutorAvailability {
  const { me } = useAuth();
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [hasIndex, setHasIndex] = useState(false);
  const [isOffline, setIsOffline] = useState(() => {
    if (typeof navigator === 'undefined') return false;
    return navigator.onLine === false;
  });

  useEffect(() => {
    let cancelled = false;
    if (!folderId || !me) {
      setReady(true);
      setSupported(false);
      setHasIndex(false);
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      const [gpuOk, meta] = await Promise.all([
        hasWebGPU(),
        loadMeta(me.userId, folderId).catch(() => null),
      ]);
      if (cancelled) return;
      setSupported(gpuOk);
      setHasIndex(meta !== null);
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [folderId, me]);

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return {
    ready,
    supported,
    hasIndex,
    available: supported && hasIndex,
    isOffline,
  };
}

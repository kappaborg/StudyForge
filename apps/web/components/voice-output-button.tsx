'use client';

import { useEffect, useState } from 'react';
import { isSpeechSynthesisSupported, speak, stopSpeaking } from '../lib/speech';

interface Props {
  text: string;
  className?: string;
}

/**
 * Speaker toggle that reads an assistant message aloud via the browser's
 * SpeechSynthesis. Click → speak. Click again → stop. Speaking another
 * card auto-cancels the previous one (handled in lib/speech).
 *
 * Hides itself when SpeechSynthesis isn't available or the text is empty.
 */
export function VoiceOutputButton({ text, className }: Props) {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => setSupported(isSpeechSynthesisSupported()), []);

  // If the text changes while we were speaking the old text, cancel.
  // The new content is likely a different message and reading the stale
  // one would be confusing.
  useEffect(() => {
    if (!active) return;
    stopSpeaking();
    setActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (!supported || !text.trim()) return null;

  const toggle = () => {
    if (active) {
      stopSpeaking();
      setActive(false);
      return;
    }
    speak(text, () => setActive(false));
    setActive(true);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={active ? 'Stop reading aloud' : 'Read aloud'}
      aria-pressed={active}
      className={`inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground ${
        active ? 'text-foreground' : ''
      } ${className ?? ''}`}
    >
      <SpeakerIcon active={active} />
    </button>
  );
}

function SpeakerIcon({ active }: { active: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19" />
      {active ? (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19 5a9 9 0 0 1 0 14" />
        </>
      ) : (
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      )}
    </svg>
  );
}

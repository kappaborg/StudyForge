'use client';

import { useEffect, useRef, useState } from 'react';
import { isSpeechRecognitionSupported, startRecognition } from '../lib/speech';

interface Props {
  /**
   * Called every time the recognizer produces an updated transcript.
   * ``replace`` indicates whether to set the field to the new text
   * (interim — the running guess) or append (final — committed segment).
   * Most parents just use the same setter for both; we expose the flag so
   * fancier callers can show interim text greyed out.
   */
  onTranscript: (text: string, final: boolean) => void;
  /** Optional disabled hook — parent might be busy answering. */
  disabled?: boolean;
  className?: string;
  /** Compact = icon only (no label). Used inside tight toolbars. */
  compact?: boolean;
}

/**
 * Microphone button that streams browser-native voice recognition into a
 * text field. Capability-detected: when the API is missing (older Firefox,
 * some embedded browsers) the button renders nothing rather than failing.
 *
 * Pattern: the parent owns the textarea state. We just push transcript
 * updates back through ``onTranscript``. That keeps voice input
 * composable with the existing Cmd+Enter / Esc shortcuts and form submit.
 */
export function VoiceInputButton({ onTranscript, disabled, className, compact }: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSupported(isSpeechRecognitionSupported());
  }, []);

  useEffect(() => () => stopRef.current?.(), []);

  if (!supported) return null;

  const toggle = () => {
    if (listening) {
      stopRef.current?.();
      stopRef.current = null;
      setListening(false);
      return;
    }
    setError(null);
    const stop = startRecognition({
      onTranscript,
      onError: (msg) => {
        if (msg) setError(msg);
        setListening(false);
      },
      onEnd: () => setListening(false),
    });
    if (stop) {
      stopRef.current = stop;
      setListening(true);
    }
  };

  return (
    <div className={`relative ${className ?? ''}`}>
      <button
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-label={listening ? 'Stop voice input' : 'Start voice input'}
        aria-pressed={listening}
        className={`flex items-center gap-1.5 rounded-md ${
          compact ? 'h-8 w-8 justify-center' : 'px-3 py-1.5 text-xs font-medium'
        } border transition-colors disabled:opacity-50 ${
          listening
            ? 'border-rose-300 bg-rose-50 text-rose-700'
            : 'border-border hover:bg-accent'
        }`}
      >
        <MicIcon listening={listening} />
        {!compact && (listening ? 'Listening…' : 'Voice')}
      </button>
      {error && (
        <p className="absolute right-0 top-full z-10 mt-1 max-w-xs rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
          {error}
        </p>
      )}
    </div>
  );
}

function MicIcon({ listening }: { listening: boolean }) {
  // Inline SVG to avoid pulling an icon library for one glyph.
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
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
      {listening && <circle cx="12" cy="8" r="1.5" fill="currentColor" />}
    </svg>
  );
}

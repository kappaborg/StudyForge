'use client';

/**
 * Capability-detected wrapper around the Web Speech APIs.
 *
 *   • SpeechRecognition  — voice → text. Webkit-prefixed on Safari, native
 *                          on Chromium. We expose a tiny manager so callers
 *                          can start/stop and subscribe to interim text.
 *   • SpeechSynthesis    — text → voice. Universally available. We pick a
 *                          reasonable default voice (English, female-ish if
 *                          present) on first use.
 *
 * Everything is best-effort: when an API is missing or fails, the helpers
 * return ``null`` / no-op so callers can decide whether to hide the UI or
 * fall back to a recorded-audio path (future work).
 */

// ── SpeechRecognition typing (DOM lib doesn't ship a clean type) ───────────

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: SpeechRecognitionAlternative;
  length: number;
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface RecognitionHandlers {
  /** Fired on every result (interim + final). ``final`` distinguishes. */
  onTranscript: (text: string, final: boolean) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
}

/**
 * Starts a recognition session and returns a stop handle. The handle is
 * idempotent — calling it twice is safe.
 */
export function startRecognition(handlers: RecognitionHandlers, lang = 'en-US'): (() => void) | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.continuous = false; // Stop on silence — feels more responsive for chat.
  rec.interimResults = true;
  rec.lang = lang;
  let stopped = false;

  rec.onresult = (e: SpeechRecognitionEvent) => {
    // Walk every new result frame and stitch the transcript. We send the
    // joined interim text on each tick so the textarea grows visibly.
    let interim = '';
    let finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      const result = e.results[i];
      if (!result) continue;
      const alt = result[0];
      if (!alt) continue;
      if (result.isFinal) finalText += alt.transcript;
      else interim += alt.transcript;
    }
    if (finalText) handlers.onTranscript(finalText, true);
    if (interim) handlers.onTranscript(interim, false);
  };
  rec.onerror = (e: SpeechRecognitionErrorEvent) => {
    handlers.onError?.(humanReadableError(e.error));
  };
  rec.onend = () => {
    handlers.onEnd?.();
  };

  try {
    rec.start();
  } catch (err) {
    handlers.onError?.(err instanceof Error ? err.message : 'Could not start mic');
    return null;
  }

  return () => {
    if (stopped) return;
    stopped = true;
    try {
      rec.stop();
    } catch {
      // Some browsers throw if stop() is called while already ending.
    }
  };
}

function humanReadableError(code: string): string {
  switch (code) {
    case 'no-speech':
      return "Didn't hear anything. Try again.";
    case 'audio-capture':
      return 'No microphone found.';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access denied. Enable it in browser settings.';
    case 'network':
      return 'Speech recognition needs a network connection.';
    case 'aborted':
      return '';
    default:
      return `Voice input failed (${code})`;
  }
}

// ── SpeechSynthesis (TTS) ──────────────────────────────────────────────────

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

let _voice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (_voice) return _voice;
  if (!isSpeechSynthesisSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return null;
  // Prefer an English voice; mild preference for "natural" / "Samantha" /
  // "Google" labels which tend to be the better-sounding presets on each
  // platform. Falls back to first English voice, then first voice.
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith('en'));
  const preferred =
    en.find((v) => /natural|samantha|google|premium/i.test(v.name)) ??
    en[0] ??
    voices[0] ??
    null;
  _voice = preferred;
  return _voice;
}

let _currentUtterance: SpeechSynthesisUtterance | null = null;

/** Speak the given text. Cancels any in-flight utterance first. */
export function speak(text: string, onEnd?: () => void): void {
  if (!isSpeechSynthesisSupported() || !text.trim()) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  if (voice) u.voice = voice;
  u.rate = 1.0;
  u.pitch = 1.0;
  u.onend = () => {
    if (_currentUtterance === u) _currentUtterance = null;
    onEnd?.();
  };
  _currentUtterance = u;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (!isSpeechSynthesisSupported()) return;
  window.speechSynthesis.cancel();
  _currentUtterance = null;
}

export function isSpeaking(): boolean {
  if (!isSpeechSynthesisSupported()) return false;
  return window.speechSynthesis.speaking;
}

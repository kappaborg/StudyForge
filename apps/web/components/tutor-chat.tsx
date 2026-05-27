'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  API_BASE,
  DEV_TENANT_ID,
  DEV_USER_EMAIL,
  DEV_USER_ID,
  apiGet,
  apiPost,
} from '../lib/dev-fetch';
import { CitationLink } from './citation-link';
import { VoiceInputButton } from './voice-input-button';
import { VoiceOutputButton } from './voice-output-button';

interface SessionRow {
  id: string;
  title: string | null;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
}

interface PersistedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  refusal: boolean;
  createdAt: string;
  citations: Array<{ chunkId: string; score: number }>;
}

interface UICitation {
  chunkId: string;
  docId?: string;
  page?: number | null;
  score: number;
}

interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  refusal?: boolean;
  citations?: UICitation[];
  streaming?: boolean;
}

interface Props {
  folderId?: string | null;
  courseId?: string | null;
}

/**
 * Full-height tutor chat: history sidebar on the left, conversation in the
 * middle, citations folded into each assistant turn. The stream endpoint
 * does the persistence — we just open a session up front and replay it on
 * mount via the messages list.
 */
export function TutorChat({ folderId, courseId }: Props) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await apiGet<{ sessions: SessionRow[] }>('/v1/chat/sessions');
      setSessions(res.sessions);
    } catch {
      // Non-fatal; sidebar just stays empty.
    }
  }, []);

  const loadMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await apiGet<{ messages: PersistedMessage[] }>(
        `/v1/chat/sessions/${sessionId}/messages`,
      );
      setMessages(
        res.messages
          .filter((m): m is PersistedMessage & { role: 'user' | 'assistant' } =>
            m.role === 'user' || m.role === 'assistant',
          )
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            refusal: m.refusal,
            citations: m.citations.map((c) => ({ chunkId: c.chunkId, score: c.score })),
          })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load messages');
    }
  }, []);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (activeId) void loadMessages(activeId);
    else setMessages([]);
  }, [activeId, loadMessages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (activeId) return activeId;
    const created = await apiPost<{ id: string }>('/v1/chat/sessions', {
      ...(courseId ? { courseId } : {}),
    });
    setActiveId(created.id);
    void loadSessions();
    return created.id;
  }, [activeId, courseId, loadSessions]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || pending) return;
    setError(null);
    setPending(true);
    setInput('');

    const sessionId = await ensureSession();
    const userMsgId = `tmp-u-${Date.now()}`;
    const assistantMsgId = `tmp-a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: text },
      { id: assistantMsgId, role: 'assistant', content: '', streaming: true },
    ]);

    try {
      const res = await fetch(`${API_BASE}/v1/chat/tutor/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-tenant-id': DEV_TENANT_ID,
          'x-user-id': DEV_USER_ID,
          'x-user-email': DEV_USER_EMAIL,
        },
        body: JSON.stringify({
          query: text,
          sessionId,
          ...(folderId ? { folderId } : {}),
          ...(courseId ? { courseId } : {}),
        }),
        credentials: 'include',
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail.slice(0, 200) || `HTTP ${res.status}`);
      }
      await consumeSse(res.body, (event, data) => {
        if (event === 'delta') {
          const piece = String(data['text'] ?? '');
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: m.content + piece } : m,
            ),
          );
        } else if (event === 'citations') {
          const list = (data['citations'] ?? []) as UICitation[];
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsgId ? { ...m, citations: list } : m)),
          );
        } else if (event === 'refusal') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: String(data['text'] ?? ''), refusal: true }
                : m,
            ),
          );
        } else if (event === 'done') {
          const finalText = data['text'];
          if (typeof finalText === 'string' && finalText.length > 0) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsgId ? { ...m, content: finalText } : m,
              ),
            );
          }
        } else if (event === 'error') {
          throw new Error(String(data['message'] ?? 'stream error'));
        }
      });
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsgId ? { ...m, streaming: false } : m)),
      );
      void loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
      setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
    } finally {
      setPending(false);
      textareaRef.current?.focus();
    }
  }, [input, pending, ensureSession, folderId, courseId, loadSessions]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Escape') {
      setInput('');
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setInput('');
    textareaRef.current?.focus();
  };

  const sortedSessions = useMemo(() => sessions, [sessions]);

  return (
    <div className="grid h-[calc(100vh-240px)] min-h-[480px] gap-4 md:h-[calc(100vh-200px)] md:min-h-[600px] md:grid-cols-[220px_1fr]">
      {/* History rail: shown inline at md+, collapsed to a <details>
          accordion on mobile so it doesn't eat the conversation pane. */}
      <aside className="hidden flex-col overflow-hidden rounded-lg border border-border md:flex">
        <button
          type="button"
          onClick={newChat}
          className="m-2 rounded-md border border-dashed border-border px-3 py-2 text-sm hover:bg-accent"
        >
          + New chat
        </button>
        <div className="flex-1 overflow-y-auto">
          {sortedSessions.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              No previous conversations yet.
            </p>
          ) : (
            <ul className="space-y-0.5 px-1">
              {sortedSessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    className={`block w-full truncate rounded px-3 py-2 text-left text-xs hover:bg-accent ${
                      s.id === activeId ? 'bg-accent font-medium' : ''
                    }`}
                  >
                    {s.title ?? 'Untitled chat'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Mobile session switcher */}
      <details className="md:hidden">
        <summary className="cursor-pointer rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          {sortedSessions.find((s) => s.id === activeId)?.title ?? 'New conversation'} · history
        </summary>
        <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
          <button
            type="button"
            onClick={newChat}
            className="block w-full px-3 py-2 text-left text-xs hover:bg-accent"
          >
            + New chat
          </button>
          {sortedSessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveId(s.id)}
              className={`block w-full truncate px-3 py-2 text-left text-xs hover:bg-accent ${
                s.id === activeId ? 'bg-accent font-medium' : ''
              }`}
            >
              {s.title ?? 'Untitled chat'}
            </button>
          ))}
        </div>
      </details>

      <main className="flex flex-col overflow-hidden rounded-lg border border-border">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-muted-foreground">
                Ask anything about your uploaded materials. Answers are cited.
              </p>
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} />
          ))}
        </div>

        {error && (
          <p className="mx-4 mb-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}

        <form
          className="border-t border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask a question — Enter to send, Cmd/Ctrl+Enter on multiline"
            rows={2}
            disabled={pending}
            className="block w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/30"
            aria-label="Question for the tutor"
          />
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {folderId
                ? 'Scoped to current folder.'
                : 'Searching all your materials.'}
            </span>
            <div className="flex items-center gap-2">
              <VoiceInputButton
                disabled={pending}
                compact
                onTranscript={(text, final) => {
                  if (!final) return; // only commit final transcript segments
                  setInput((prev) => (prev ? prev.trimEnd() + ' ' + text : text));
                }}
              />
              <button
                type="submit"
                disabled={pending || !input.trim()}
                className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
              >
                {pending ? 'Asking…' : 'Send'}
              </button>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
          isUser
            ? 'bg-foreground text-background'
            : message.refusal
              ? 'border border-border bg-muted/30'
              : 'border border-border bg-accent/30'
        }`}
      >
        <p className="whitespace-pre-wrap leading-relaxed">
          {message.content}
          {message.streaming && message.content === '' && (
            <span className="text-muted-foreground">Thinking…</span>
          )}
          {message.streaming && message.content !== '' && (
            <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-current align-middle" />
          )}
        </p>
        {!isUser && !message.streaming && message.content && (
          <div className="mt-2 flex justify-end">
            <VoiceOutputButton text={message.content} />
          </div>
        )}
        {!isUser && message.citations && message.citations.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {message.citations.length} citation{message.citations.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 flex flex-wrap gap-1.5 text-muted-foreground">
              {message.citations.map((c, i) => (
                <li key={c.chunkId}>
                  <CitationLink
                    ord={i + 1}
                    source={{ kind: 'cloud', chunkId: c.chunkId }}
                    label="source"
                  />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  handle: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let evName = 'message';
      const dataParts: string[] = [];
      for (const ln of frame.split('\n')) {
        if (ln.startsWith('event:')) evName = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataParts.push(ln.slice(5).trim());
      }
      if (dataParts.length > 0) {
        try {
          handle(evName, JSON.parse(dataParts.join('\n')) as Record<string, unknown>);
        } catch {
          // Bad JSON frame
        }
      }
      sep = buf.indexOf('\n\n');
    }
  }
}

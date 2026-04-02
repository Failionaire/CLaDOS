import { useState, useRef, useEffect } from 'react';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PendingDiff {
  id: string;
  file: string;
  diff: string;
}

interface InteractiveChatProps {
  /** Whether the pipeline is in 'complete' status */
  visible: boolean;
}

export function InteractiveChat({ visible }: InteractiveChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingDiff, setPendingDiff] = useState<PendingDiff | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  if (!visible) return null;

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);

    try {
      const resp = await fetch('/interactive/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.content }]);
      if (data.diff) {
        setPendingDiff(data.diff);
      }
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${(e as Error).message}` }]);
    } finally {
      setLoading(false);
    }
  };

  const handleDiffAction = async (action: 'approve' | 'reject') => {
    if (!pendingDiff) return;
    try {
      await fetch(`/interactive/diff/${action}`, { method: 'POST' });
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: action === 'approve'
          ? `Applied changes to ${pendingDiff.file}`
          : `Rejected changes to ${pendingDiff.file}`,
      }]);
    } catch { /* ignore */ }
    setPendingDiff(null);
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>Interactive Mode</span>
        <span style={styles.headerSub}>Project complete — chat to iterate</span>
      </div>

      <div ref={scrollRef} style={styles.messages}>
        {messages.length === 0 && (
          <div style={styles.welcome}>
            Your project pipeline is complete. Ask me anything about the generated code, request changes, or explore the architecture.
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{
            ...styles.message,
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            background: msg.role === 'user' ? 'var(--ap-blue-lo, #0d2847)' : 'var(--surface2)',
            borderColor: msg.role === 'user' ? 'var(--ap-blue-border, #1a4a80)' : 'var(--border)',
          }}>
            <div style={styles.messageRole}>{msg.role === 'user' ? 'You' : 'Assistant'}</div>
            <div style={styles.messageContent}>{msg.content}</div>
          </div>
        ))}

        {loading && (
          <div style={{ ...styles.message, alignSelf: 'flex-start', background: 'var(--surface2)', borderColor: 'var(--border)' }}>
            <div style={styles.messageContent}>Thinking…</div>
          </div>
        )}
      </div>

      {pendingDiff && (
        <div style={styles.diffBanner}>
          <div style={styles.diffHeader}>Proposed change: {pendingDiff.file}</div>
          <pre style={styles.diffContent}>{pendingDiff.diff}</pre>
          <div style={styles.diffActions}>
            <button style={styles.approveBtn} onClick={() => handleDiffAction('approve')}>Apply</button>
            <button style={styles.rejectBtn} onClick={() => handleDiffAction('reject')}>Reject</button>
          </div>
        </div>
      )}

      <div style={styles.inputBar}>
        <input
          style={styles.input}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Ask about or modify your project…"
          disabled={loading}
        />
        <button style={styles.sendBtn} onClick={sendMessage} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--surface)',
  },
  header: {
    padding: '12px 20px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'baseline',
    gap: 12,
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text)',
  },
  headerSub: {
    fontSize: 12,
    color: 'var(--text-3)',
  },
  messages: {
    flex: 1,
    overflow: 'auto',
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  welcome: {
    padding: 24,
    textAlign: 'center' as const,
    color: 'var(--text-3)',
    fontSize: 13,
    lineHeight: 1.6,
  },
  message: {
    maxWidth: '80%',
    padding: '8px 12px',
    border: '1px solid',
    borderRadius: 4,
  },
  messageRole: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    color: 'var(--text-3)',
    marginBottom: 2,
  },
  messageContent: {
    fontSize: 13,
    color: 'var(--text)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap' as const,
  },
  diffBanner: {
    margin: '0 16px',
    border: '1px solid var(--amber-border, #665500)',
    background: 'var(--amber-lo, #3a3000)',
    padding: 12,
  },
  diffHeader: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--amber)',
    marginBottom: 8,
  },
  diffContent: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text)',
    maxHeight: 200,
    overflow: 'auto',
    margin: 0,
    padding: 8,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
  },
  diffActions: {
    display: 'flex',
    gap: 8,
    marginTop: 8,
  },
  approveBtn: {
    padding: '4px 16px',
    background: 'var(--green-lo, #0a2f0a)',
    border: '1px solid var(--green-border, #1a5f1a)',
    color: 'var(--green)',
    cursor: 'pointer',
    fontSize: 12,
  },
  rejectBtn: {
    padding: '4px 16px',
    background: 'var(--red-lo, #2f0a0a)',
    border: '1px solid var(--red-border, #5f1a1a)',
    color: 'var(--red)',
    cursor: 'pointer',
    fontSize: 12,
  },
  inputBar: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    gap: 8,
  },
  input: {
    flex: 1,
    padding: '8px 12px',
    background: 'var(--surface2)',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: 13,
    outline: 'none',
  },
  sendBtn: {
    padding: '8px 20px',
    background: 'var(--ap-blue-lo, #0d2847)',
    border: '1px solid var(--ap-blue-border, #1a4a80)',
    color: 'var(--ap-blue)',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
};

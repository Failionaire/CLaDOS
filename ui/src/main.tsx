import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, fontFamily: 'var(--font-mono)', background: 'var(--bg)', minHeight: '100vh', color: 'var(--text)' }}>
          <div style={{ color: 'var(--red)', fontWeight: 700, fontSize: 15, marginBottom: 12 }}>CLaDOS encountered an error.</div>
          <pre style={{ fontSize: 12, color: 'var(--text-3)', whiteSpace: 'pre-wrap', marginBottom: 20 }}>
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '6px 16px', cursor: 'pointer', background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 13 }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

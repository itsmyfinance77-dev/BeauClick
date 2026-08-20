'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Application error boundary. A render error must never blank the page --
 * it shows a Persian message and a recovery action. Error DETAIL is
 * logged to the console for developers but never rendered, matching the
 * backend's own discipline (BeauClickExceptionFilter: full detail
 * server-side, generic Persian message to the user).
 */
interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Phase 1: console only. A real error-reporting sink (Sentry per
    // V3_INFRASTRUCTURE_PLAN.md §7) is Phase 4 infrastructure scope.
    console.error('[BeauClick] Unhandled UI error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div role="alert" style={{ padding: 24, textAlign: 'center' }}>
        <h2>مشکلی پیش آمد</h2>
        <p style={{ color: 'var(--bc-color-ink-soft)' }}>لطفاً صفحه را دوباره بارگذاری کنید.</p>
        <button
          type="button"
          onClick={() => this.setState({ hasError: false })}
          style={{
            font: 'inherit',
            fontWeight: 600,
            padding: '10px 18px',
            marginBlockStart: 12,
            borderRadius: 'var(--bc-radius-button)',
            border: 'none',
            background: 'var(--bc-color-primary)',
            color: 'var(--bc-color-surface)',
            cursor: 'pointer',
            minHeight: 44,
          }}
        >
          تلاش دوباره
        </button>
      </div>
    );
  }
}

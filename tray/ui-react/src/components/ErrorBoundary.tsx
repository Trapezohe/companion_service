import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 20,
            fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
            color: 'rgba(255,255,255,0.85)',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>
            UI failed to render
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: 'rgba(255,255,255,0.08)',
              padding: 10,
              borderRadius: 6,
              fontSize: 11,
              lineHeight: 1.5,
              maxHeight: 400,
              overflow: 'auto',
            }}
          >
            {this.state.error.message}
            {'\n'}
            {this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

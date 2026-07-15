import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Nade Viewer render error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="fatal-error-view">
        <div className="fatal-error-card">
          <span className="fatal-error-icon"><AlertTriangle size={22} /></span>
          <div className="eyebrow">Viewer error</div>
          <h1>The page could not be displayed</h1>
          <p>{this.state.error.message || "An unexpected interface error occurred."}</p>
          <button className="btn primary" onClick={() => window.location.reload()}><RotateCw size={15} />Reload viewer</button>
        </div>
      </div>
    );
  }
}

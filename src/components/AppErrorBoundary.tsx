import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { useI18n } from '../i18n';

type Props = { children: ReactNode };
type State = { error: Error | null };

function ErrorBoundaryView({
  error,
  children,
}: {
  error: Error | null;
  children: ReactNode;
}) {
  const { tr } = useI18n();
  if (!error) return children;
  return (
    <div className="fatal-error-view">
      <div className="fatal-error-card">
        <span className="fatal-error-icon">
          <AlertTriangle size={22} />
        </span>
        <div className="eyebrow">{tr('Viewer error', 'Ошибка просмотра')}</div>
        <h1>
          {tr(
            'The page could not be displayed',
            'Не удалось отобразить страницу',
          )}
        </h1>
        <p>
          {tr(
            'An unexpected interface error occurred.',
            'Произошла непредвиденная ошибка интерфейса.',
          )}
        </p>
        <button
          className="btn primary"
          onClick={() => window.location.reload()}
        >
          <RotateCw size={15} />
          {tr('Reload viewer', 'Перезагрузить просмотр')}
        </button>
      </div>
    </div>
  );
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Nade Viewer render error', error, info);
  }

  render() {
    return (
      <ErrorBoundaryView error={this.state.error}>
        {this.props.children}
      </ErrorBoundaryView>
    );
  }
}

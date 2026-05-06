import { Component, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  message: string;
};

export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: ""
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error.message
    };
  }

  componentDidCatch(error: Error) {
    console.error("UI error:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <section className="panel">
          <h1>画面エラー</h1>
          <p>表示中に問題が発生しました。</p>
          <div className="error-box">
            {this.state.message || "詳細なエラーはコンソールに出力されます。"}
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

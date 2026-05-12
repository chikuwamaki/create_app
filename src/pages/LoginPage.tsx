import { useState } from "react";
import { useAuth } from "react-oidc-context";

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const auth = useAuth();

  const handleLogin = async () => {
    setError(null);
    try {
      await auth.signinRedirect();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "ログインに失敗しました。"
      );
    }
  };

  const handleSignup = async () => {
    setError(null);
    try {
      await auth.signinRedirect();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "新規登録に失敗しました。"
      );
    }
  };

  return (
    <section className="panel">
      <h1>ログイン</h1>
      <p>AWSの認証画面に移動してログインします。</p>
      <p>新規登録は認証画面の「Sign up」から行ってください。</p>
      <div className="form-grid">
        <div className="action-row">
          <button
            className="primary-button"
            type="button"
            onClick={handleLogin}
            disabled={auth.isLoading}
          >
            ログイン
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={handleSignup}
            disabled={auth.isLoading}
          >
            新規登録
          </button>
        </div>
        {error ? <div className="error-box">{error}</div> : null}
      </div>
    </section>
  );
}

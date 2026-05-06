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

  return (
    <section className="panel">
      <h1>ログイン</h1>
      <p>AWSの認証画面に移動してログインします。</p>
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
        </div>
        {error ? <div className="error-box">{error}</div> : null}
      </div>
    </section>
  );
}

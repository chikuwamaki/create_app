import { useState } from "react";
import { useAuth } from "react-oidc-context";

export default function LoginPage() {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setError(null);
    try {
      await auth.signinRedirect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    }
  };

  return (
    <section className="panel">
      <h1>管理者ログイン</h1>
      <p>管理者用の認証画面に移動してログインします。</p>
      <button
        className="primary-button"
        type="button"
        onClick={handleLogin}
        disabled={auth.isLoading}
      >
        ログイン
      </button>
      {error ? <div className="notice notice--error">{error}</div> : null}
    </section>
  );
}

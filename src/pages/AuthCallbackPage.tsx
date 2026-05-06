import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "react-oidc-context";

export default function AuthCallbackPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (auth.isAuthenticated) {
      navigate("/", { replace: true });
    }
  }, [auth.isAuthenticated, navigate]);

  return (
    <section className="panel">
      <h1>ログイン処理</h1>
      {auth.error ? (
        <div className="error-box">
          <p>{auth.error.message}</p>
          <Link className="secondary-button" to="/">
            ログイン画面へ戻る
          </Link>
        </div>
      ) : (
        <p>認証情報を確認しています。少々お待ちください。</p>
      )}
    </section>
  );
}

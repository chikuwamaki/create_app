import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "react-oidc-context";
import { buildLogoutUrl } from "./auth/oidcConfig";
import { getRoleFromProfile, roleLabels, type Role } from "./auth/roles";
import ErrorBoundary from "./components/ErrorBoundary";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import LoginPage from "./pages/LoginPage";
import ShiftSubmitPage from "./pages/ShiftSubmitPage";
import ShiftCreatePage from "./pages/ShiftCreatePage";
import ShiftListPage from "./pages/ShiftListPage";

const navByRole: Record<Role, Array<{ to: string; label: string }>> = {
  staff: [
    { to: "/submit", label: "シフト提出" },
    { to: "/list", label: "シフト確認" }
  ],
  manager: [
    { to: "/create", label: "シフト作成" },
    { to: "/list", label: "シフト確認" }
  ]
};

export default function App() {
  const auth = useAuth();
  const location = useLocation();
  const isCallbackRoute = location.pathname === "/auth/callback";
  const role = getRoleFromProfile(auth.user?.profile);
  const isAuthenticated = auth.isAuthenticated && !!role;
  const navItems = role ? navByRole[role] : [];
  const defaultRoute = role === "staff" ? "/submit" : "/create";

  const handleLogout = () => {
    auth.removeUser();
    window.location.assign(buildLogoutUrl());
  };

  if (isCallbackRoute) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <AuthCallbackPage />
        </main>
      </div>
    );
  }

  if (auth.isLoading) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <section className="panel">
            <h1>読み込み中</h1>
            <p>認証状態を確認しています。</p>
          </section>
        </main>
      </div>
    );
  }

  if (auth.error) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <section className="panel">
            <h1>認証エラー</h1>
            <div className="error-box">{auth.error.message}</div>
          </section>
        </main>
      </div>
    );
  }

  if (auth.isAuthenticated && !role) {
    return (
      <div className="app-shell">
        <main className="app-main">
          <section className="panel">
            <h1>ロール未設定</h1>
            <div className="error-box">
              <p>ユーザーのロールが設定されていません。</p>
              <button className="secondary-button" onClick={handleLogout}>
                ログアウト
              </button>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">シフト管理</div>
        {isAuthenticated ? (
          <>
            <nav className="nav">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    isActive ? "nav-link nav-link--active" : "nav-link"
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <div className="header-actions">
              <span className="role-badge">{role ? roleLabels[role] : ""}</span>
              <button
                className="secondary-button"
                type="button"
                onClick={handleLogout}
              >
                ログアウト
              </button>
            </div>
          </>
        ) : null}
      </header>
      <main className="app-main">
        <ErrorBoundary>
          <Routes>
            <Route
              path="/"
              element={
                isAuthenticated ? (
                  <Navigate to={defaultRoute} replace />
                ) : (
                  <LoginPage />
                )
              }
            />
            <Route
              path="/auth/callback"
              element={<AuthCallbackPage />}
            />
            <Route
              path="/submit"
              element={
                role === "staff" ? (
                  <ShiftSubmitPage />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route
              path="/create"
              element={
                role === "manager" ? (
                  <ShiftCreatePage />
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route
              path="/list"
              element={
                isAuthenticated ? <ShiftListPage /> : <Navigate to="/" replace />
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ErrorBoundary>
      </main>
    </div>
  );
}

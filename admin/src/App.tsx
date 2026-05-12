import React from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "react-oidc-context";
import { isAdminUser } from "./auth/adminAuth";
import { buildLogoutUrl } from "./auth/oidcConfig";
import LoginPage from "./pages/LoginPage";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import SubmissionsPage from "./pages/SubmissionsPage";
import AssignmentsPage from "./pages/AssignmentsPage";
import UsersPage from "./pages/UsersPage";
import PublishPage from "./pages/PublishPage";
import TtlPage from "./pages/TtlPage";

function PrivateRoute({ children }: { children: JSX.Element }) {
  const auth = useAuth();
  if (!auth.isAuthenticated) {
    return <Navigate to="/login" />;
  }
  if (!isAdminUser(auth.user?.profile)) {
    return <div>Forbidden</div>;
  }
  return children;
}

export default function App() {
  const auth = useAuth();

  const handleLogout = async () => {
    await auth.removeUser();
    window.location.assign(buildLogoutUrl());
  };

  return (
    <div className="admin-root">
      <header className="admin-header">
        <h1>管理ツール</h1>
        <nav>
          <NavLink to="/">提出</NavLink>
          <NavLink to="/assignments">割当</NavLink>
          <NavLink to="/publish">公開状態</NavLink>
          <NavLink to="/users">ユーザー</NavLink>
          <NavLink to="/ttl">データ整理</NavLink>
        </nav>
        <div className="auth">
          {auth.isAuthenticated ? (
            <button onClick={handleLogout}>ログアウト</button>
          ) : (
            <NavLink to="/login">ログイン</NavLink>
          )}
        </div>
      </header>

      <main className="admin-main">
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <PrivateRoute>
                <SubmissionsPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/assignments"
            element={
              <PrivateRoute>
                <AssignmentsPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/publish"
            element={
              <PrivateRoute>
                <PublishPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/users"
            element={
              <PrivateRoute>
                <UsersPage />
              </PrivateRoute>
            }
          />
          <Route
            path="/ttl"
            element={
              <PrivateRoute>
                <TtlPage />
              </PrivateRoute>
            }
          />
        </Routes>
      </main>
    </div>
  );
}

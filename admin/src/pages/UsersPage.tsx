import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { fetchAdminUsers, updateAdminUser, type AdminUser } from "../api/adminApi";

export default function UsersPage() {
  const auth = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const getToken = () => auth.user?.id_token || auth.user?.access_token;

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const res = await fetchAdminUsers({
        query,
        token: getToken() || "",
        limit: 50
      });
      setUsers(res.users || []);
    } catch (error) {
      setUsers([]);
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const toggleAdmin = async (username: string, isAdmin: boolean) => {
    setLoading(true);
    try {
      await updateAdminUser({
        username,
        isAdmin: !isAdmin,
        token: getToken() || ""
      });
      await load();
    } finally {
      setLoading(false);
    }
  };

  const setRole = async (username: string, role?: "staff" | "manager") => {
    setLoading(true);
    try {
      await updateAdminUser({
        username,
        role,
        token: getToken() || ""
      });
      await load();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>ユーザー管理</h2>
      <div className="controls">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="メールまたはユーザー名で検索"
        />
        <button onClick={load} disabled={loading}>
          検索
        </button>
      </div>

      {notice ? <div className="notice notice--error">{notice}</div> : null}

      <table className="simple-table">
        <thead>
          <tr>
            <th>ユーザー</th>
            <th>メール</th>
            <th>権限グループ</th>
            <th>役割</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={5}>読み込み中...</td>
            </tr>
          ) : users.length ? (
            users.map((user) => {
            const username = user.username ?? "";
            const groups = user.groups ?? [];
            const isAdmin = groups.includes(
              import.meta.env.VITE_ADMIN_GROUP_NAME || "admins"
            );
            return (
              <tr key={username}>
                <td>
                  <strong>{user.name || user.email || username}</strong>
                  <div className="muted-id">{username}</div>
                </td>
                <td>{user.email ?? "-"}</td>
                <td>{groups.join(", ")}</td>
                <td>{user.role || "未設定"}</td>
                <td>
                  <button onClick={() => toggleAdmin(username, isAdmin)}>
                    {isAdmin ? "管理者を外す" : "管理者にする"}
                  </button>
                  <button onClick={() => setRole(username, "manager")}>
                    店長
                  </button>
                  <button onClick={() => setRole(username)}>役割解除</button>
                </td>
              </tr>
            );
            })
          ) : (
            <tr>
              <td colSpan={5}>ユーザーが見つかりません。</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

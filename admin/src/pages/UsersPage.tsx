import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { fetchAdminUsers, updateAdminUser } from "../api/adminApi";

export default function UsersPage() {
  const auth = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const getToken = () => auth.user?.id_token || auth.user?.access_token;

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchAdminUsers({ query, token: getToken() || "" });
      setUsers(res.users || []);
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

      <table className="simple-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Groups</th>
            <th>Role</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user: any) => {
            const username = user.username ?? "";
            const groups = user.groups ?? [];
            const isAdmin = groups.includes(
              import.meta.env.VITE_ADMIN_GROUP_NAME || "admins"
            );
            return (
              <tr key={username}>
                <td>{username}</td>
                <td>{user.email ?? "-"}</td>
                <td>{groups.join(", ")}</td>
                <td>{user.role || "-"}</td>
                <td>
                  <button onClick={() => toggleAdmin(username, isAdmin)}>
                    toggle admin
                  </button>
                  <button onClick={() => setRole(username, "manager")}>
                    manager
                  </button>
                  <button onClick={() => setRole(username)}>clear role</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

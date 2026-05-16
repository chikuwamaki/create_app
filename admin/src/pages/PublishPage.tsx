import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  deleteAdminPublishState,
  fetchAdminPublish,
  fetchAdminUsers,
  setAdminPublishState,
  type AdminUser,
  type AdminPublish
} from "../api/adminApi";
import { defaultOperationalMonth, monthOptions } from "../utils/monthOptions";

const months = monthOptions({ past: 12, future: 3 });

export default function PublishPage() {
  const auth = useAuth();
  const token = auth.user?.id_token || auth.user?.access_token || "";
  const initialMonth = defaultOperationalMonth();
  const [month, setMonth] = useState(
    months.some((item) => item.value === initialMonth)
      ? initialMonth
      : months[months.length - 1].value
  );
  const [state, setState] = useState<AdminPublish | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const publishedByUser = users.find(
    (user) =>
      user.username === state?.publishedBy || user.userId === state?.publishedBy
  );
  const publishedByLabel = publishedByUser
    ? publishedByUser.name || publishedByUser.email || publishedByUser.username
    : state?.publishedBy;

  const load = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const publishState = await fetchAdminPublish({ month, token });
      setState(publishState);
      try {
        const userResult = await fetchAdminUsers({ token, limit: 50 });
        setUsers(userResult.users);
      } catch {
        setUsers([]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const setPublished = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const next = await setAdminPublishState({
        month,
        status: "published",
        token
      });
      setState(next);
      setNotice("公開状態にしました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const clearState = async () => {
    const ok = window.confirm(
      `${month} の公開状態を削除します。シフトデータ自体は削除されません。`
    );
    if (!ok) {
      return;
    }
    setLoading(true);
    setNotice(null);
    try {
      await deleteAdminPublishState({ month, token });
      setState({ status: "draft" });
      setNotice("公開状態を削除しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>公開状態</h2>
      <p className="hint">
        通常の公開操作は店長画面で行います。ここでは管理者が公開状態だけを確認・補正できます。
      </p>
      <div className="controls">
        <label>
          月
          <select value={month} onChange={(event) => setMonth(event.target.value)}>
            {months.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={load} disabled={loading}>
          確認
        </button>
        <button onClick={setPublished} disabled={loading}>
          公開状態にする
        </button>
        <button onClick={clearState} disabled={loading}>
          公開状態を削除
        </button>
      </div>
      <table className="simple-table">
        <tbody>
          <tr>
            <th>状態</th>
            <td>{state?.status === "published" ? "公開済み" : "未公開"}</td>
          </tr>
          <tr>
            <th>公開日時</th>
            <td>{state?.publishedAt ?? "-"}</td>
          </tr>
          <tr>
            <th>公開者</th>
            <td>
              {publishedByLabel ?? "-"}
              {state?.publishedBy ? (
                <div className="muted-id">{state.publishedBy}</div>
              ) : null}
            </td>
          </tr>
        </tbody>
      </table>
      {notice ? <div className="notice notice--success">{notice}</div> : null}
    </div>
  );
}

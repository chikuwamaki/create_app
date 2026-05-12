import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { monthOptions } from "../utils/monthOptions";
import { fetchAdminSubmissions } from "../api/adminApi";

export default function SubmissionsPage() {
  const auth = useAuth();
  const [month, setMonth] = useState<string>(monthOptions()[0].value);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const getToken = () => auth.user?.id_token || auth.user?.access_token;

  useEffect(() => {
    fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const fetch = async () => {
    setLoading(true);
    try {
      const token = getToken();
      const res = await fetchAdminSubmissions({ month, token: token || "" });
      setItems(res);
    } finally {
      setLoading(false);
    }
  };

  const downloadCsv = () => {
    if (!items.length) return;
    const headers = Object.keys(items[0]);
    const csv = [headers.join(",")]
      .concat(
        items.map((r) => headers.map((h) => JSON.stringify(r[h] ?? "")).join(","))
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `submissions-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2>提出一覧</h2>
      <div className="controls">
        <label>
          月:
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {monthOptions().map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={fetch} disabled={loading}>
          更新
        </button>
        <button onClick={downloadCsv} disabled={!items.length}>
          CSVダウンロード
        </button>
      </div>

      {loading ? (
        <div>読み込み中...</div>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>ユーザー</th>
              <th>日付</th>
              <th>状態</th>
              <th>その他</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it: any, idx: number) => (
              <tr key={idx}>
                <td>{it.userId || it.owner || "-"}</td>
                <td>{it.date || it.createdAt || "-"}</td>
                <td>{it.status || "-"}</td>
                <td>{JSON.stringify(it.data || {})}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

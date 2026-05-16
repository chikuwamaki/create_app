import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { defaultOperationalMonth, monthOptions } from "../utils/monthOptions";
import { fetchAdminSubmissions, type AdminSubmission } from "../api/adminApi";

function formatSlots(slotsByDate: Record<string, string[]>): string {
  const entries = Object.entries(slotsByDate)
    .filter(([, slots]) => slots.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) {
    return "希望なし";
  }

  return entries
    .map(([date, slots]) => `${date} ${slots.length}枠 (${slots.join(", ")})`)
    .join(" / ");
}

function countSlots(slotsByDate: Record<string, string[]>): number {
  return Object.values(slotsByDate).reduce(
    (total, slots) => total + slots.length,
    0
  );
}

function csvEscape(value: unknown): string {
  return JSON.stringify(value ?? "");
}

export default function SubmissionsPage() {
  const auth = useAuth();
  const months = monthOptions();
  const initialMonth = defaultOperationalMonth();
  const [month, setMonth] = useState<string>(
    months.some((item) => item.value === initialMonth)
      ? initialMonth
      : months[0].value
  );
  const [items, setItems] = useState<AdminSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

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
    const rows = filteredItems;
    if (!rows.length) return;
    const headers = [
      "name",
      "rolePreference",
      "slotCount",
      "slots",
      "userId",
      "updatedAt",
      "expiresAt"
    ];
    const csv = [headers.join(",")]
      .concat(
        rows.map((item) =>
          [
            item.name,
            item.rolePreference,
            countSlots(item.slotsByDate),
            formatSlots(item.slotsByDate),
            item.userId,
            item.updatedAt,
            item.expiresAt
          ]
            .map(csvEscape)
            .join(",")
        )
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

  const filteredItems = items.filter((item) => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return true;
    }
    return (
      item.name.toLowerCase().includes(keyword) ||
      item.userId.toLowerCase().includes(keyword) ||
      item.rolePreference.toLowerCase().includes(keyword)
    );
  });

  return (
    <div>
      <h2>提出一覧</h2>
      <div className="controls">
        <label>
          月:
          <select value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="名前・ID・役割で絞り込み"
        />
        <button onClick={fetch} disabled={loading}>
          更新
        </button>
        <button onClick={downloadCsv} disabled={!filteredItems.length}>
          CSVダウンロード
        </button>
      </div>

      {loading ? (
        <div>読み込み中...</div>
      ) : (
        <table className="simple-table">
          <thead>
            <tr>
              <th>スタッフ</th>
              <th>希望役割</th>
              <th>希望枠</th>
              <th>希望日時</th>
              <th>更新日時</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => (
              <tr key={item.userId}>
                <td>
                  <strong>{item.name}</strong>
                  <div className="muted-id">{item.userId}</div>
                </td>
                <td>{item.rolePreference}</td>
                <td>{countSlots(item.slotsByDate)}枠</td>
                <td>{formatSlots(item.slotsByDate)}</td>
                <td>{item.updatedAt ?? "-"}</td>
              </tr>
            ))}
            {!filteredItems.length ? (
              <tr>
                <td colSpan={5}>提出データがありません。</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  deleteAdminAssignments,
  fetchAdminAssignments,
  fetchAdminSubmissions,
  upsertAdminAssignments,
  type AdminAssignment,
  type AdminSubmission,
  type AssignmentRole
} from "../api/adminApi";
import { defaultOperationalMonth, monthOptions } from "../utils/monthOptions";

const roles: Array<{ value: AssignmentRole; label: string }> = [
  { value: "ホール", label: "ホール" },
  { value: "キッチン", label: "キッチン" }
];

const months = monthOptions({ past: 12, future: 3 });

function firstDayOfMonth(month: string): string {
  return `${month}-01`;
}

function roleLabel(role: string): string {
  return roles.find((item) => item.value === role)?.label ?? role;
}

function csvEscape(value: unknown): string {
  return JSON.stringify(value ?? "");
}

type Notice = {
  tone: "success" | "error";
  text: string;
} | null;

export default function AssignmentsPage() {
  const auth = useAuth();
  const token = auth.user?.id_token || auth.user?.access_token || "";
  const initialMonth = defaultOperationalMonth();
  const [month, setMonth] = useState(
    months.some((item) => item.value === initialMonth)
      ? initialMonth
      : months[months.length - 1].value
  );
  const [dateFilter, setDateFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [staffFilter, setStaffFilter] = useState("");
  const [items, setItems] = useState<AdminAssignment[]>([]);
  const [submissions, setSubmissions] = useState<AdminSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [form, setForm] = useState<AdminAssignment>({
    date: firstDayOfMonth(month),
    time: "09:00",
    role: roles[0].value,
    staffId: "",
    staffName: ""
  });

  const staffOptions = useMemo(() => {
    const unique = new Map<string, string>();
    submissions.forEach((submission) => {
      unique.set(submission.userId, submission.name);
    });
    return Array.from(unique, ([userId, name]) => ({ userId, name })).sort(
      (a, b) => a.name.localeCompare(b.name, "ja")
    );
  }, [submissions]);

  const visibleItems = useMemo(
    () => {
      const keyword = staffFilter.trim().toLowerCase();
      const filtered = keyword
        ? items.filter(
            (item) =>
              item.staffName.toLowerCase().includes(keyword) ||
              item.staffId.toLowerCase().includes(keyword)
          )
        : items;

      return [...filtered].sort(
        (a, b) =>
          a.date.localeCompare(b.date) ||
          a.time.localeCompare(b.time) ||
          roleLabel(a.role).localeCompare(roleLabel(b.role), "ja") ||
          a.staffName.localeCompare(b.staffName, "ja")
      );
    },
    [items, staffFilter]
  );

  const load = async () => {
    if (!token) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    setLoading(true);
    setNotice(null);
    try {
      const [assignments, availability] = await Promise.all([
        fetchAdminAssignments({
          month,
          token,
          date: dateFilter || undefined,
          role: roleFilter || undefined
        }),
        fetchAdminSubmissions({ month, token })
      ]);
      setItems(assignments);
      setSubmissions(availability);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      date: prev.date.startsWith(month) ? prev.date : firstDayOfMonth(month)
    }));
  }, [month]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const updateForm = <K extends keyof AdminAssignment>(
    key: K,
    value: AdminAssignment[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const selectStaff = (staffId: string) => {
    const staff = staffOptions.find((item) => item.userId === staffId);
    setForm((prev) => ({
      ...prev,
      staffId,
      staffName: staff?.name ?? prev.staffName
    }));
  };

  const save = async () => {
    if (!token) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    if (!form.date || !form.time || !form.role || !form.staffId || !form.staffName) {
      setNotice({
        tone: "error",
        text: "日付、時間、役割、スタッフID、スタッフ名を入力してください。"
      });
      return;
    }
    if (!form.date.startsWith(month)) {
      setNotice({
        tone: "error",
        text: "選択中の月と日付の月が一致していません。"
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await upsertAdminAssignments({ month, token, assignments: [form] });
      setNotice({ tone: "success", text: "割当を保存しました。" });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: AdminAssignment) => {
    const ok = window.confirm(
      `${item.date} ${item.time} ${roleLabel(item.role)} ${item.staffName} の割当を削除します。`
    );
    if (!ok) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await deleteAdminAssignments({
        month,
        token,
        keys: [
          {
            date: item.date,
            time: item.time,
            role: item.role,
            staffId: item.staffId
          }
        ]
      });
      setNotice({ tone: "success", text: "割当を削除しました。" });
      await load();
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  const edit = (item: AdminAssignment) => {
    setForm({
      date: item.date,
      time: item.time,
      role: item.role,
      staffId: item.staffId,
      staffName: item.staffName
    });
  };

  const downloadCsv = () => {
    if (!visibleItems.length) {
      return;
    }
    const headers = ["date", "time", "role", "roleLabel", "staffId", "staffName"];
    const rows = visibleItems.map((item) =>
      [
        item.date,
        item.time,
        item.role,
        roleLabel(item.role),
        item.staffId,
        item.staffName
      ]
        .map(csvEscape)
        .join(",")
    );
    const blob = new Blob([[headers.join(","), ...rows].join("\n")], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `assignments-${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2>シフト割当管理</h2>
      <p className="hint">
        DynamoDBに保存されている月別のシフト割当を検索、追加、更新、削除できます。
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
        <label>
          日付
          <input
            type="date"
            value={dateFilter}
            onChange={(event) => setDateFilter(event.target.value)}
          />
        </label>
        <label>
          役割
          <select
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
          >
            <option value="">すべて</option>
            {roles.map((role) => (
              <option key={role.value} value={role.value}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          スタッフ名/ID
          <input
            value={staffFilter}
            onChange={(event) => setStaffFilter(event.target.value)}
            placeholder="名前またはID"
          />
        </label>
        <button onClick={load} disabled={loading}>
          検索
        </button>
        <button onClick={downloadCsv} disabled={!visibleItems.length}>
          CSV
        </button>
      </div>

      <section className="admin-editor">
        <h3>割当を追加・更新</h3>
        <div className="controls">
          <label>
            日付
            <input
              type="date"
              value={form.date}
              onChange={(event) => updateForm("date", event.target.value)}
            />
          </label>
          <label>
            時間
            <input
              type="time"
              step="1800"
              value={form.time}
              onChange={(event) => updateForm("time", event.target.value)}
            />
          </label>
          <label>
            役割
            <select
              value={form.role}
              onChange={(event) =>
                updateForm("role", event.target.value as AssignmentRole)
              }
            >
              {roles.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            提出済みスタッフ
            <select
              value={form.staffId}
              onChange={(event) => selectStaff(event.target.value)}
            >
              <option value="">手入力</option>
              {staffOptions.map((staff) => (
                <option key={staff.userId} value={staff.userId}>
                  {staff.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            スタッフID
            <input
              value={form.staffId}
              onChange={(event) => updateForm("staffId", event.target.value)}
            />
          </label>
          <label>
            スタッフ名
            <input
              value={form.staffName}
              onChange={(event) => updateForm("staffName", event.target.value)}
            />
          </label>
          <button onClick={save} disabled={saving}>
            保存
          </button>
        </div>
      </section>

      {notice ? <div className={`notice notice--${notice.tone}`}>{notice.text}</div> : null}

      <table className="simple-table">
        <thead>
          <tr>
            <th>日付</th>
            <th>時間</th>
            <th>役割</th>
            <th>スタッフ</th>
            <th>ID</th>
            <th>更新日時</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={7}>読み込み中...</td>
            </tr>
          ) : visibleItems.length ? (
            visibleItems.map((item) => (
              <tr
                key={`${item.date}-${item.time}-${item.role}-${item.staffId}`}
              >
                <td>{item.date}</td>
                <td>{item.time}</td>
                <td>{roleLabel(item.role)}</td>
                <td>
                  <strong>{item.staffName}</strong>
                </td>
                <td>
                  <span className="muted-id">{item.staffId}</span>
                </td>
                <td>{item.updatedAt ?? "-"}</td>
                <td>
                  <button type="button" onClick={() => edit(item)}>
                    編集
                  </button>
                  <button type="button" onClick={() => remove(item)}>
                    削除
                  </button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={7}>割当データがありません。</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

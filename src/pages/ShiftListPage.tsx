import { useEffect, useMemo, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  fetchAssignments,
  fetchPublishState,
  type Assignment,
  type PublishState
} from "../api/shiftApi";

type Row = {
  date: string;
  start: string;
  end: string;
  role: string;
  staffName: string;
};

const SLOT_MINUTES = 30;

function toMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function toTime(minutes: number): string {
  const hour = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const minute = `${minutes % 60}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function formatDateLabel(dateKey: string): string {
  const [, month, day] = dateKey.split("-").map(Number);
  return `${month.toString().padStart(2, "0")}/${day
    .toString()
    .padStart(2, "0")}`;
}

function buildRows(assignments: Assignment[]): Row[] {
  const grouped = new Map<string, Assignment[]>();
  assignments.forEach((assignment) => {
    const key = `${assignment.date}|${assignment.role}|${assignment.staffId}`;
    const group = grouped.get(key) ?? [];
    group.push(assignment);
    grouped.set(key, group);
  });

  const rows: Row[] = [];
  grouped.forEach((group) => {
    const sample = group[0];
    const times = group.map((item) => item.time).sort();
    let rangeStart = times[0];
    let prevMinutes = toMinutes(times[0]);
    for (let index = 1; index < times.length; index += 1) {
      const minutes = toMinutes(times[index]);
      if (minutes === prevMinutes + SLOT_MINUTES) {
        prevMinutes = minutes;
        continue;
      }
      rows.push({
        date: sample.date,
        role: sample.role,
        staffName: sample.staffName,
        start: rangeStart,
        end: toTime(prevMinutes + SLOT_MINUTES)
      });
      rangeStart = times[index];
      prevMinutes = minutes;
    }
    rows.push({
      date: sample.date,
      role: sample.role,
      staffName: sample.staffName,
      start: rangeStart,
      end: toTime(prevMinutes + SLOT_MINUTES)
    });
  });

  return rows.sort((a, b) => {
    const dateCompare = a.date.localeCompare(b.date);
    if (dateCompare !== 0) {
      return dateCompare;
    }
    const timeCompare = toMinutes(a.start) - toMinutes(b.start);
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return a.role.localeCompare(b.role);
  });
}

export default function ShiftListPage() {
  const auth = useAuth();
  const idToken = auth.user?.id_token;
  const [selectedMonth, setSelectedMonth] = useState("2026-06");
  const [publishState, setPublishState] = useState<PublishState>({
    status: "draft"
  });
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(assignments), [assignments]);

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!idToken) {
      return;
    }
    let active = true;
    setIsLoading(true);
    fetchPublishState({ month: selectedMonth, token: idToken })
      .then((state) => {
        if (!active) {
          return null;
        }
        setPublishState(state);
        if (state.status === "published") {
          return fetchAssignments({ month: selectedMonth, token: idToken });
        }
        return null;
      })
      .then((result) => {
        if (!active) {
          return;
        }
        if (result && result.status === "published") {
          setAssignments(result.items);
        } else {
          setAssignments([]);
        }
      })
      .catch((err) => {
        if (active) {
          setNotice(
            err instanceof Error ? err.message : "シフト取得に失敗しました。"
          );
          setAssignments([]);
        }
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedMonth, idToken]);

  return (
    <section className="panel">
      <h1>シフト確認</h1>
      <p>
        状態: {publishState.status === "published" ? "公開済み" : "未公開"}
      </p>
      <div className="action-row">
        <select
          aria-label="月を選択"
          value={selectedMonth}
          onChange={(event) => setSelectedMonth(event.target.value)}
        >
          <option>2026-06</option>
          <option>2026-07</option>
          <option>2026-08</option>
        </select>
      </div>
      {notice ? <div className="notice notice--error">{notice}</div> : null}
      {isLoading ? <p className="hint">シフトを読み込み中...</p> : null}
      {publishState.status !== "published" ? (
        <p className="hint">この月のシフトはまだ公開されていません。</p>
      ) : rows.length ? (
        <table className="table" style={{ marginTop: 16 }}>
          <thead>
            <tr>
              <th>日付</th>
              <th>時間</th>
              <th>役割</th>
              <th>担当</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.date}-${row.role}-${row.staffName}-${index}`}>
                <td>{formatDateLabel(row.date)}</td>
                <td>{`${row.start}-${row.end}`}</td>
                <td>{row.role}</td>
                <td>{row.staffName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">公開済みのシフトがありません。</p>
      )}
    </section>
  );
}

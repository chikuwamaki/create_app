import { useEffect, useMemo, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  fetchAssignments,
  fetchPublishState,
  fetchSubmissions,
  type Assignment,
  type PublishState
} from "../api/shiftApi";
import { formatMonth, getMonthOptions } from "../utils/monthOptions";

type Row = {
  date: string;
  start: string;
  end: string;
  role: string;
  staffName: string;
};

type DayCell = {
  date: string;
  label: string;
  inMonth: boolean;
  isToday: boolean;
};

const SLOT_MINUTES = 30;
const days = ["日", "月", "火", "水", "木", "金", "土"];
const roles = ["ホール", "キッチン"] as const;
type RoleKey = (typeof roles)[number];

function toMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function toTime(minutes: number): string {
  const hour = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const minute = `${minutes % 60}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function buildCalendar(monthValue: string): DayCell[][] {
  const [year, month] = monthValue.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const start = new Date(firstDay);
  start.setDate(firstDay.getDate() - firstDay.getDay());
  const todayKey = formatDate(new Date());
  const weeks: DayCell[][] = [];

  const cursor = new Date(start);
  for (let week = 0; week < 6; week += 1) {
    const row: DayCell[] = [];
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const cellDate = new Date(cursor);
      const dateKey = formatDate(cellDate);
      row.push({
        date: dateKey,
        label: `${cellDate.getDate()}`,
        inMonth: cellDate.getMonth() === month - 1,
        isToday: dateKey === todayKey
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(row);
  }

  return weeks;
}

function buildTimeSlots(
  startTime: string,
  endTime: string,
  intervalMinutes: number
): string[] {
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  const slots: string[] = [];

  for (let minutes = start; minutes <= end; minutes += intervalMinutes) {
    slots.push(toTime(minutes));
  }

  return slots;
}

function formatSelectedDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return `${month}/${day}(${days[date.getDay()]})`;
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

const timeSlots = buildTimeSlots("09:00", "21:00", SLOT_MINUTES);

export default function ShiftListPage() {
  const auth = useAuth();
  const idToken = auth.user?.id_token;
  const userId = (auth.user?.profile as { sub?: string } | undefined)?.sub;
  const monthOptions = useMemo(() => getMonthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(
    monthOptions[0] ?? formatMonth(new Date())
  );
  const [viewMode, setViewMode] = useState<"self" | "month">("self");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<PublishState>({
    status: "draft"
  });
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const weeks = useMemo(() => buildCalendar(selectedMonth), [selectedMonth]);
  const selfRows = useMemo(() => {
    if (!userId) {
      return [];
    }
    return buildRows(assignments.filter((assignment) => assignment.staffId === userId));
  }, [assignments, userId]);

  const selectedDateLabel = selectedDate
    ? formatSelectedDate(selectedDate)
    : "未選択";

  const assignmentsByRole = useMemo(() => {
    const map: Record<RoleKey, Record<string, string[]>> = {
      ホール: {},
      キッチン: {}
    };
    if (!selectedDate) {
      return map;
    }
    assignments
      .filter((assignment) => assignment.date === selectedDate)
      .forEach((assignment) => {
        const role = assignment.role as RoleKey;
        const timeMap = map[role] ?? {};
        const names = timeMap[assignment.time] ?? [];
        if (!names.includes(assignment.staffName)) {
          names.push(assignment.staffName);
        }
        timeMap[assignment.time] = names;
        map[role] = timeMap;
      });
    return map;
  }, [assignments, selectedDate]);

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
          return Promise.all([
            fetchAssignments({ month: selectedMonth, token: idToken }),
            fetchSubmissions({ month: selectedMonth, token: idToken })
          ]);
        }
        return null;
      })
      .then((result) => {
        if (!active) {
          return;
        }
        if (result && result[0].status === "published") {
          const [, submissions] = result;
          const staffNames = new Map(
            submissions.map((submission) => [submission.userId, submission.name])
          );
          setAssignments(
            result[0].items
              .filter((assignment) => staffNames.has(assignment.staffId))
              .map((assignment) => ({
                ...assignment,
                staffName: staffNames.get(assignment.staffId) ?? assignment.staffName
              }))
          );
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

  useEffect(() => {
    const [year, month] = selectedMonth.split("-").map(Number);
    const firstDate = formatDate(new Date(year, month - 1, 1));
    setSelectedDate((prev) =>
      prev && prev.startsWith(selectedMonth) ? prev : firstDate
    );
  }, [selectedMonth]);

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
          {monthOptions.map((month) => (
            <option key={month} value={month}>
              {month}
            </option>
          ))}
        </select>
        <div className="action-row">
          <button
            type="button"
            className={viewMode === "self" ? "primary-button" : "secondary-button"}
            onClick={() => setViewMode("self")}
          >
            自分のシフト
          </button>
          <button
            type="button"
            className={viewMode === "month" ? "primary-button" : "secondary-button"}
            onClick={() => setViewMode("month")}
          >
            月間ビュー
          </button>
        </div>
      </div>
      {notice ? <div className="notice notice--error">{notice}</div> : null}
      {isLoading ? <p className="hint">シフトを読み込み中...</p> : null}
      {publishState.status !== "published" ? (
        <p className="hint">この月のシフトはまだ公開されていません。</p>
      ) : viewMode === "self" ? (
        selfRows.length ? (
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
              {selfRows.map((row, index) => (
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
          <p className="hint">該当するシフトがありません。</p>
        )
      ) : (
        <div className="shift-create-layout" style={{ marginTop: 16 }}>
          <div className="list-card">
            <h3>日付選択</h3>
            <div className="calendar">
              <div className="calendar-header">
                {days.map((day) => (
                  <div key={day} className="calendar-day-label">
                    {day}
                  </div>
                ))}
              </div>
              <div className="calendar-grid">
                {weeks.map((week, weekIndex) => (
                  <div key={`week-${weekIndex}`} className="calendar-week">
                    {week.map((day, dayIndex) => (
                      <button
                        key={`day-${weekIndex}-${dayIndex}`}
                        className={[
                          "calendar-day",
                          !day.inMonth && "calendar-day--muted",
                          day.isToday && "calendar-day--today",
                          day.date === selectedDate &&
                            "calendar-day--selected"
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        type="button"
                        disabled={!day.inMonth}
                        onClick={() => setSelectedDate(day.date)}
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <p className="hint">選択中: {selectedDateLabel}</p>
          </div>
          <div className="list-card">
            <h3>シフト表</h3>
            <div className="assignment-table" role="grid">
              <div
                className="assignment-row assignment-row--header"
                style={{
                  gridTemplateColumns: `72px repeat(${roles.length}, minmax(0, 1fr))`
                }}
              >
                <div className="assignment-time-cell">時間</div>
                {roles.map((role) => (
                  <div key={role} className="assignment-staff-cell">
                    {role}
                  </div>
                ))}
              </div>
              {timeSlots.map((time) => (
                <div
                  key={time}
                  className="assignment-row"
                  style={{
                    gridTemplateColumns: `72px repeat(${roles.length}, minmax(0, 1fr))`
                  }}
                >
                  <div className="assignment-time-cell">{time}</div>
                  {roles.map((role) => {
                    const names = assignmentsByRole[role]?.[time] ?? [];
                    return (
                      <div
                        key={`${role}-${time}`}
                        className="assignment-cell"
                      >
                        {names.length ? names.join(" / ") : "—"}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  fetchSubmissions,
  submitAvailability,
  type SubmissionRole
} from "../api/shiftApi";
import { formatMonth, getMonthOptions } from "../utils/monthOptions";

const days = ["日", "月", "火", "水", "木", "金", "土"];

type DayCell = {
  date: string;
  label: string;
  inMonth: boolean;
  isToday: boolean;
};

type Notice = {
  tone: "success" | "error";
  text: string;
} | null;

const submissionRoles: SubmissionRole[] = ["ホール", "キッチン", "どちらでも"];

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
    const hour = `${Math.floor(minutes / 60)}`.padStart(2, "0");
    const minute = `${minutes % 60}`.padStart(2, "0");
    slots.push(`${hour}:${minute}`);
  }

  return slots;
}

function parseTimeToMinutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function formatMinutes(minutes: number): string {
  const hour = `${Math.floor(minutes / 60)}`.padStart(2, "0");
  const minute = `${minutes % 60}`.padStart(2, "0");
  return `${hour}:${minute}`;
}

function buildRanges(slots: string[], intervalMinutes: number): string[] {
  if (slots.length === 0) {
    return [];
  }
  const sorted = [...slots].sort();
  const ranges: string[] = [];
  let rangeStart = parseTimeToMinutes(sorted[0]);
  let prev = rangeStart;

  for (let i = 1; i < sorted.length; i += 1) {
    const current = parseTimeToMinutes(sorted[i]);
    if (current === prev + intervalMinutes) {
      prev = current;
      continue;
    }
    ranges.push(
      `${formatMinutes(rangeStart)}-${formatMinutes(prev + intervalMinutes)}`
    );
    rangeStart = current;
    prev = current;
  }

  ranges.push(
    `${formatMinutes(rangeStart)}-${formatMinutes(prev + intervalMinutes)}`
  );
  return ranges;
}

function formatSlotRange(time: string, intervalMinutes: number): string {
  const start = parseTimeToMinutes(time);
  return `${time}-${formatMinutes(start + intervalMinutes)}`;
}

function formatSelectedDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return `${month}/${day}(${days[date.getDay()]})`;
}

const timeSlots = buildTimeSlots("09:00", "21:00", 30);

export default function ShiftSubmitPage() {
  const auth = useAuth();
  const idToken = auth.user?.id_token;
  const monthOptions = useMemo(() => getMonthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(
    monthOptions[0] ?? formatMonth(new Date())
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [rolePreference, setRolePreference] = useState<SubmissionRole>("ホール");
  const [slotsByDate, setSlotsByDate] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const dragState = useRef<{ active: boolean; mode: "add" | "remove" | null }>({
    active: false,
    mode: null
  });

  const weeks = useMemo(() => buildCalendar(selectedMonth), [selectedMonth]);

  useEffect(() => {
    const [year, month] = selectedMonth.split("-").map(Number);
    const firstDate = formatDate(new Date(year, month - 1, 1));
    setSelectedDate((prev) =>
      prev && prev.startsWith(selectedMonth) ? prev : firstDate
    );
  }, [selectedMonth]);

  useEffect(() => {
    if (!idToken) {
      return;
    }
    let active = true;
    setIsLoading(true);
    fetchSubmissions({
      month: selectedMonth,
      token: idToken,
      scope: "self"
    })
      .then((items) => {
        if (!active) {
          return;
        }
        const entry = items[0];
        if (entry) {
          setRolePreference(entry.rolePreference ?? "ホール");
          setSlotsByDate(entry.slotsByDate ?? {});
        } else {
          setRolePreference("ホール");
          setSlotsByDate({});
        }
      })
      .catch((err) => {
        if (active) {
          setNotice({
            tone: "error",
            text: err instanceof Error ? err.message : "取得に失敗しました。"
          });
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
    if (!notice) {
      return undefined;
    }
    const timer = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const stopDrag = () => {
      dragState.current = { active: false, mode: null };
    };
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    return () => {
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
    };
  }, []);

  const selectedSlots = selectedDate ? slotsByDate[selectedDate] ?? [] : [];
  const selectedDateLabel = selectedDate
    ? formatSelectedDate(selectedDate)
    : "未選択";
  const selectedRanges = useMemo(
    () => buildRanges(selectedSlots, 30),
    [selectedSlots]
  );

  const applySlot = (time: string, mode: "add" | "remove") => {
    if (!selectedDate) {
      setNotice({ tone: "error", text: "日付を選択してください。" });
      return;
    }
    setSlotsByDate((prev) => {
      const current = new Set(prev[selectedDate] ?? []);
      const has = current.has(time);
      if (mode === "add" && !has) {
        current.add(time);
      }
      if (mode === "remove" && has) {
        current.delete(time);
      }
      return {
        ...prev,
        [selectedDate]: Array.from(current).sort()
      };
    });
  };

  const startDrag = (time: string) => {
    if (!selectedDate) {
      setNotice({ tone: "error", text: "日付を選択してください。" });
      return;
    }
    const mode = selectedSlots.includes(time) ? "remove" : "add";
    dragState.current = { active: true, mode };
    applySlot(time, mode);
  };

  const dragOver = (time: string) => {
    if (!dragState.current.active || !dragState.current.mode) {
      return;
    }
    applySlot(time, dragState.current.mode);
  };

  const handleSave = () => {
    if (!selectedDate) {
      setNotice({ tone: "error", text: "日付を選択してください。" });
      return;
    }
    if (!idToken) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    setIsSaving(true);
    submitAvailability({
      payload: {
        month: selectedMonth,
        rolePreference,
        slotsByDate
      },
      token: idToken
    })
      .then(() => {
        setNotice({ tone: "success", text: "保存しました。" });
      })
      .catch((err) => {
        setNotice({
          tone: "error",
          text: err instanceof Error ? err.message : "保存に失敗しました。"
        });
      })
      .finally(() => setIsSaving(false));
  };

  return (
    <section className="panel">
      <h1>シフト提出</h1>
      <p>状態: 下書き（編集可）</p>
      <div className="action-row">
        <select
          aria-label="月を選択"
          value={selectedMonth}
          onChange={(event) => setSelectedMonth(event.target.value)}
          disabled={isLoading || isSaving}
        >
          {monthOptions.map((month) => (
            <option key={month} value={month}>
              {month}
            </option>
          ))}
        </select>
        <select
          aria-label="担当可能な役割"
          value={rolePreference}
          onChange={(event) =>
            setRolePreference(event.target.value as SubmissionRole)
          }
          disabled={isLoading || isSaving}
        >
          {submissionRoles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button
          className="primary-button"
          type="button"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? "保存中..." : "提出"}
        </button>
      </div>
      <div className="status-row">
        <span className="status-pill">選択中: {selectedDateLabel}</span>
        <span className="status-pill">希望役割: {rolePreference}</span>
        <span className="status-pill">選択数: {selectedSlots.length}枠</span>
      </div>
      {isLoading ? <p className="hint">提出データを読み込み中...</p> : null}
      {notice ? (
        <div className={`notice notice--${notice.tone}`}>{notice.text}</div>
      ) : null}
      <div className="grid-two" style={{ marginTop: 20 }}>
        <div className="list-card">
          <h3>カレンダー</h3>
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
                        day.date === selectedDate && "calendar-day--selected"
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
          <p>日付を選択して、入れる時間をクリックまたはドラッグで指定します。</p>
        </div>
        <div className="list-card">
          <h3>時間グリッド（30分）</h3>
          <div className="time-grid">
            <div className="time-grid-header">
              <div className="time-day">{selectedDateLabel}</div>
            </div>
            {timeSlots.map((time) => (
              <div key={time} className="time-row">
                <button
                  className={
                    selectedSlots.includes(time)
                      ? "time-slot time-slot--selected"
                      : "time-slot"
                  }
                  type="button"
                  aria-label={`${selectedDateLabel} ${formatSlotRange(time, 30)} を選択`}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startDrag(time);
                  }}
                  onPointerEnter={() => dragOver(time)}
                >
                  <span className="time-slot-range">
                    {formatSlotRange(time, 30)}
                  </span>
                  {selectedSlots.includes(time) ? (
                    <span className="time-slot-state">選択中</span>
                  ) : null}
                </button>
              </div>
            ))}
          </div>
          <div className="slot-summary">
            <div className="slot-summary-header">
              <span className="slot-summary-title">選択済み</span>
              <span className="slot-summary-count">
                {selectedRanges.length}件
              </span>
            </div>
            {selectedRanges.length ? (
              <div className="slot-chip-list">
                {selectedRanges.map((range) => (
                  <span key={range} className="slot-chip">
                    {range}
                  </span>
                ))}
              </div>
            ) : (
              <p className="slot-empty">未選択</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

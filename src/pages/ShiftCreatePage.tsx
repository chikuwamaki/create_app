import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  fetchAssignments,
  fetchPublishState,
  fetchSubmissions,
  generateAssignments,
  publishAssignments,
  saveAssignments,
  type Assignment as ApiAssignment,
  type GenerateAssignmentsResult,
  type PublishState,
  type StaffingRules,
  type Submission
} from "../api/shiftApi";
import { formatMonth, getMonthOptions } from "../utils/monthOptions";
import { renderMarkdownText } from "../utils/markdown";

type DayCell = {
  date: string;
  label: string;
  inMonth: boolean;
  isToday: boolean;
};

type Assignment = {
  staffId: string;
};

type AssignmentSlot = Record<string, Assignment>;
type AssignmentsByDate = Record<
  string,
  Record<RoleKey, Record<string, AssignmentSlot>>
>;

type Notice = {
  tone: "success" | "error";
  text: string;
} | null;

type Staff = {
  id: string;
  name: string;
  roles: string[];
};

const days = ["日", "月", "火", "水", "木", "金", "土"];
const roles = ["ホール", "キッチン"] as const;
type RoleKey = (typeof roles)[number];

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function firstDayOfMonth(monthValue: string): string {
  return `${monthValue}-01`;
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

function assignmentsFromApi(assignments: ApiAssignment[]): AssignmentsByDate {
  const next: AssignmentsByDate = {};
  assignments.forEach((assignment) => {
    if (!roles.includes(assignment.role as RoleKey)) {
      return;
    }
    const role = assignment.role as RoleKey;
    const day = next[assignment.date] ?? {};
    const roleAssignments = day[role] ?? {};
    const slotAssignments = roleAssignments[assignment.time] ?? {};
    roleAssignments[assignment.time] = {
      ...slotAssignments,
      [assignment.staffId]: { staffId: assignment.staffId }
    };
    next[assignment.date] = {
      ...day,
      [role]: roleAssignments
    };
  });
  return next;
}

export default function ShiftCreatePage() {
  const auth = useAuth();
  const idToken = auth.user?.id_token;
  const monthOptions = useMemo(() => getMonthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(
    monthOptions[0] ?? formatMonth(new Date())
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedRole, setSelectedRole] = useState<RoleKey>("ホール");
  const [assignmentsByDate, setAssignmentsByDate] = useState<AssignmentsByDate>(
    {}
  );
  const [notice, setNotice] = useState<Notice>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>({
    status: "draft"
  });
  const [isPublishing, setIsPublishing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [minStaffPerSlot, setMinStaffPerSlot] = useState(2);
  const [weekdayStaffPerSlot, setWeekdayStaffPerSlot] = useState(2);
  const [weekendStaffPerSlot, setWeekendStaffPerSlot] = useState(3);
  const [dateOverrides, setDateOverrides] = useState<Record<string, number>>({});
  const [overrideDate, setOverrideDate] = useState(firstDayOfMonth(selectedMonth));
  const [overrideCount, setOverrideCount] = useState(4);
  const [generatedResult, setGeneratedResult] =
    useState<GenerateAssignmentsResult | null>(null);
  const dragState = useRef<{ active: boolean; mode: "assign" | "clear" | null }>({
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
    setOverrideDate((prev) =>
      prev.startsWith(selectedMonth) ? prev : firstDayOfMonth(selectedMonth)
    );
    setDateOverrides({});
    setGeneratedResult(null);
  }, [selectedMonth]);

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
    fetchSubmissions({ month: selectedMonth, token: idToken })
      .then((items) => {
        if (active) {
          setSubmissions(items);
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
    if (!idToken) {
      return;
    }
    let active = true;
    fetchPublishState({ month: selectedMonth, token: idToken })
      .then((state) => {
        if (!active) {
          return null;
        }
        setPublishState(state);
        return fetchAssignments({ month: selectedMonth, token: idToken });
      })
      .then((result) => {
        if (!active || !result) {
          return;
        }
        setAssignmentsByDate(assignmentsFromApi(result.items));
      })
      .catch((err) => {
        if (active) {
          setNotice({
            tone: "error",
            text:
              err instanceof Error
                ? err.message
                : "公開状態の取得に失敗しました。"
          });
        }
      });

    return () => {
      active = false;
    };
  }, [selectedMonth, idToken]);

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

  const selectedDateLabel = selectedDate
    ? formatSelectedDate(selectedDate)
    : "未選択";
  const dayAssignments = selectedDate
    ? assignmentsByDate[selectedDate]?.[selectedRole] ?? {}
    : {};
  const assignedCount = selectedDate
    ? timeSlots.reduce(
        (count, time) => count + Object.keys(dayAssignments[time] ?? {}).length,
        0
      )
    : 0;
  const unassignedCount = selectedDate
    ? timeSlots.filter((time) => !Object.keys(dayAssignments[time] ?? {}).length)
        .length
    : 0;
  const submissionsForDate = selectedDate
    ? submissions.filter(
        (submission) => (submission.slotsByDate?.[selectedDate]?.length ?? 0) > 0
      )
    : [];

  const availabilityMap = useMemo(() => {
    if (!selectedDate) {
      return {} as Record<string, Set<string>>;
    }
    const map: Record<string, Set<string>> = {};
    submissionsForDate.forEach((submission) => {
      const slots = submission.slotsByDate?.[selectedDate] ?? [];
      if (slots.length) {
        map[submission.userId] = new Set(slots);
      }
    });
    return map;
  }, [selectedDate, submissionsForDate]);

  const staffById = useMemo(() => {
    const map = new Map<string, string>();
    submissions.forEach((submission) => {
      map.set(submission.userId, submission.name ?? "スタッフ");
    });
    return map;
  }, [submissions]);

  const staffForRole: Staff[] = submissionsForDate
    .filter((submission) => {
      const role = submission.rolePreference ?? "どちらでも";
      return role === selectedRole || role === "どちらでも";
    })
    .map((submission) => ({
      id: submission.userId,
      name: submission.name ?? "スタッフ",
      roles: [submission.rolePreference ?? "どちらでも"]
    }));

  const buildAssignmentsPayload = (): ApiAssignment[] => {
    const items: ApiAssignment[] = [];
    Object.entries(assignmentsByDate).forEach(([date, rolesByDate]) => {
      if (!date.startsWith(selectedMonth)) {
        return;
      }
      roles.forEach((role) => {
        const assignments = rolesByDate?.[role] ?? {};
        Object.entries(assignments).forEach(([time, slotAssignments]) => {
          Object.values(slotAssignments).forEach((assignment) => {
            const staffName = staffById.get(assignment.staffId) ?? "スタッフ";
            items.push({
              date,
              time,
              role,
              staffId: assignment.staffId,
              staffName
            });
          });
        });
      });
    });
    return items;
  };

  const applyCell = (
    time: string,
    staffId: string,
    mode: "assign" | "clear"
  ) => {
    if (!selectedDate) {
      setNotice({ tone: "error", text: "日付を選択してください。" });
      return;
    }
    setAssignmentsByDate((prev) => {
      const day = prev[selectedDate] ?? {};
      const roleAssignments = day[selectedRole] ?? {};
      const nextRoleAssignments = { ...roleAssignments };
      const slotAssignments = nextRoleAssignments[time] ?? {};
      const nextSlotAssignments = { ...slotAssignments };
      if (mode === "assign") {
        nextSlotAssignments[staffId] = { staffId };
        nextRoleAssignments[time] = nextSlotAssignments;
      }
      if (mode === "clear") {
        delete nextSlotAssignments[staffId];
        if (Object.keys(nextSlotAssignments).length) {
          nextRoleAssignments[time] = nextSlotAssignments;
        } else {
          delete nextRoleAssignments[time];
        }
      }
      return {
        ...prev,
        [selectedDate]: {
          ...day,
          [selectedRole]: nextRoleAssignments
        }
      };
    });
  };

  const startDrag = (time: string, staffId: string, isSelected: boolean) => {
    if (!selectedDate) {
      setNotice({ tone: "error", text: "日付を選択してください。" });
      return;
    }
    const mode: "assign" | "clear" = isSelected ? "clear" : "assign";
    dragState.current = { active: true, mode };
    applyCell(time, staffId, mode);
  };

  const dragOver = (time: string, staffId: string) => {
    if (!dragState.current.active || !dragState.current.mode) {
      return;
    }
    applyCell(time, staffId, dragState.current.mode);
  };

  const addDateOverride = () => {
    if (!overrideDate.startsWith(selectedMonth)) {
      setNotice({
        tone: "error",
        text: "特定日は選択中の月内の日付を指定してください。"
      });
      return;
    }
    setDateOverrides((prev) => ({
      ...prev,
      [overrideDate]: Math.max(1, Math.min(10, overrideCount))
    }));
  };

  const removeDateOverride = (date: string) => {
    setDateOverrides((prev) => {
      const next = { ...prev };
      delete next[date];
      return next;
    });
  };

  const handleGenerateAssignments = async () => {
    if (!idToken) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    const staffingRules: StaffingRules = {
      defaultStaffPerSlot: minStaffPerSlot,
      weekdayStaffPerSlot,
      weekendStaffPerSlot,
      dateOverrides
    };
    setIsGenerating(true);
    try {
      const result = await generateAssignments({
        month: selectedMonth,
        token: idToken,
        minStaffPerSlot,
        staffingRules,
        roles: [...roles]
      });
      setAssignmentsByDate(assignmentsFromApi(result.assignments));
      setGeneratedResult(result);
      setNotice({
        tone: "success",
        text: `自動作成案を反映しました。割当案${result.assignments.length}件、不足${result.shortages.length}件です。`
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "自動作成に失敗しました。"
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!idToken) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    const assignments = buildAssignmentsPayload();
    if (!assignments.length) {
      setNotice({ tone: "error", text: "割当がありません。" });
      return;
    }
    setIsPublishing(true);
    try {
      await saveAssignments({
        payload: { month: selectedMonth, assignments },
        token: idToken
      });
      setNotice({ tone: "success", text: "下書き保存しました。" });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "保存に失敗しました。"
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const handlePublish = async () => {
    if (!idToken) {
      setNotice({ tone: "error", text: "認証情報がありません。" });
      return;
    }
    const assignments = buildAssignmentsPayload();
    if (!assignments.length) {
      setNotice({ tone: "error", text: "割当がありません。" });
      return;
    }
    setIsPublishing(true);
    try {
      await saveAssignments({
        payload: { month: selectedMonth, assignments },
        token: idToken
      });
      const nextState = await publishAssignments({
        month: selectedMonth,
        token: idToken
      });
      setPublishState(nextState);
      setNotice({
        tone: "success",
        text: "公開しました。"
      });
    } catch (err) {
      setNotice({
        tone: "error",
        text: err instanceof Error ? err.message : "公開に失敗しました。"
      });
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <section className="panel">
      <h1>シフト作成</h1>
      <p>
        状態: {publishState.status === "published" ? "公開済み" : "下書き"}
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
        <select
          aria-label="シフト種別を選択"
          value={selectedRole}
          onChange={(event) => setSelectedRole(event.target.value as RoleKey)}
        >
          {roles.map((role) => (
            <option key={role} value={role}>
              {role}
            </option>
          ))}
        </select>
        <button
          className="primary-button"
          type="button"
          onClick={handlePublish}
          disabled={isPublishing}
        >
          {isPublishing
            ? "公開中..."
            : "公開"}
        </button>
        <button
          className="secondary-button"
          type="button"
          onClick={handleSaveDraft}
          disabled={isPublishing}
        >
          下書き保存
        </button>
      </div>
      <div className="auto-assign-panel">
        <div className="auto-assign-controls">
          <label>
            基本
            <input
              min={1}
              max={10}
              type="number"
              value={minStaffPerSlot}
              onChange={(event) =>
                setMinStaffPerSlot(
                  Math.max(1, Math.min(10, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <label>
            平日
            <input
              min={1}
              max={10}
              type="number"
              value={weekdayStaffPerSlot}
              onChange={(event) =>
                setWeekdayStaffPerSlot(
                  Math.max(1, Math.min(10, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <label>
            土日
            <input
              min={1}
              max={10}
              type="number"
              value={weekendStaffPerSlot}
              onChange={(event) =>
                setWeekendStaffPerSlot(
                  Math.max(1, Math.min(10, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <label>
            特定日
            <input
              type="date"
              value={overrideDate}
              onChange={(event) => setOverrideDate(event.target.value)}
            />
          </label>
          <label>
            人数
            <input
              min={1}
              max={10}
              type="number"
              value={overrideCount}
              onChange={(event) =>
                setOverrideCount(
                  Math.max(1, Math.min(10, Number(event.target.value) || 1))
                )
              }
            />
          </label>
          <button type="button" onClick={addDateOverride}>
            特定日追加
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={handleGenerateAssignments}
            disabled={isGenerating}
          >
            {isGenerating ? "作成中..." : "自動作成"}
          </button>
        </div>
        {Object.keys(dateOverrides).length ? (
          <div className="override-list">
            {Object.entries(dateOverrides)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([date, count]) => (
                <span key={date} className="override-chip">
                  {date}: {count}人
                  <button type="button" onClick={() => removeDateOverride(date)}>
                    ×
                  </button>
                </span>
              ))}
          </div>
        ) : null}
        {generatedResult ? (
          <div className="formula-box">
            割当案: {generatedResult.assignments.length}件 / 不足:
            {generatedResult.shortages.length}件
            <br />
            <div className="markdown-body">
              {renderMarkdownText(generatedResult.explanation)}
            </div>
          </div>
        ) : (
          <p className="hint">
            希望シフトをもとに、平日・土日・特定日の必要人数を考慮して割当案を作成します。
          </p>
        )}
      </div>
      <div className="status-row">
        <span className="status-pill">選択中: {selectedDateLabel}</span>
        <span className="status-pill">シフト種別: {selectedRole}</span>
        <span className="status-pill">割当済み: {assignedCount}枠</span>
        <span className="status-pill">未割当: {unassignedCount}枠</span>
      </div>
      <div className="legend-row">
        <span className="legend-item">
          <span className="legend-swatch legend-available" />提出あり
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-assigned" />割当済み
        </span>
      </div>
      {notice ? (
        <div className={`notice notice--${notice.tone}`}>{notice.text}</div>
      ) : null}
      {isLoading ? <p className="hint">提出データを読み込み中...</p> : null}
      <div className="shift-create-layout" style={{ marginTop: 20 }}>
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
          <p className="hint">日付を選ぶと割当を編集できます。</p>
          <h3>提出一覧（{selectedRole}）</h3>
          <ul className="staff-list">
            {staffForRole.length ? (
              staffForRole.map((member) => (
                <li key={member.id} className="staff-card">
                  <div className="staff-name">{member.name}</div>
                  <div className="staff-roles">
                    {member.roles.map((role) => (
                      <span key={role} className="role-chip">
                        {role}
                      </span>
                    ))}
                  </div>
                  <div className="staff-meta">
                    提出枠: {availabilityMap[member.id]?.size ?? 0}枠
                  </div>
                </li>
              ))
            ) : (
              <li className="staff-card">
                <div className="staff-name">提出がありません</div>
                <div className="staff-meta">対象日に提出済みのスタッフがいません。</div>
              </li>
            )}
          </ul>
        </div>
        <div className="list-card">
          <h3>シフト表（{selectedRole}）</h3>
          {staffForRole.length ? (
            <div className="assignment-table" role="grid">
              <div
                className="assignment-row assignment-row--header"
                style={{
                  gridTemplateColumns: `112px repeat(${staffForRole.length}, minmax(0, 1fr))`
                }}
              >
                <div className="assignment-time-cell">時間帯</div>
                {staffForRole.map((member) => (
                  <div key={member.id} className="assignment-staff-cell">
                    {member.name}
                  </div>
                ))}
              </div>
              {timeSlots.map((time) => (
                <div
                  key={time}
                  className="assignment-row"
                  style={{
                    gridTemplateColumns: `112px repeat(${staffForRole.length}, minmax(0, 1fr))`
                  }}
                >
                  <div className="assignment-time-cell">
                    {formatSlotRange(time, 30)}
                  </div>
                  {staffForRole.map((member) => {
                    const isSelected = Boolean(
                      dayAssignments[time]?.[member.id]
                    );
                    const isAvailable =
                      availabilityMap[member.id]?.has(time) ?? false;
                    return (
                      <button
                        key={`${member.id}-${time}`}
                        type="button"
                        className={[
                          "assignment-cell",
                          isAvailable && "assignment-cell--available",
                          isSelected && "assignment-cell--selected"
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-label={`${time} ${member.name} に割当`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          startDrag(time, member.id, isSelected);
                        }}
                        onPointerEnter={() => dragOver(time, member.id)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            <p className="slot-empty">この役割のスタッフがいません。</p>
          )}
        </div>
      </div>
    </section>
  );
}

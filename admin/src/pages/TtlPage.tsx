import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import {
  backfillTtl,
  deleteMonthData,
  fetchDataSummary,
  purgeOldData,
  type AdminDataSummary
} from "../api/adminApi";
import { monthOptions } from "../utils/monthOptions";

const months = monthOptions({ past: 24, future: 3 });

export default function TtlPage() {
  const auth = useAuth();
  const token = auth.user?.id_token || auth.user?.access_token || "";
  const [targetMonth, setTargetMonth] = useState(months[months.length - 1].value);
  const [cutoffMonth, setCutoffMonth] = useState(months[12]?.value ?? months[0].value);
  const [summary, setSummary] = useState<AdminDataSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSummary = async () => {
    setLoading(true);
    setNotice(null);
    try {
      setSummary(await fetchDataSummary({ month: targetMonth, token }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMonth]);

  const runBackfill = async () => {
    setLoading(true);
    setNotice(null);
    try {
      const selectedMonths = months.map((item) => item.value);
      await backfillTtl({ months: selectedMonths, token });
      setNotice("表示範囲のデータに保持期限を設定しました。");
      await loadSummary();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const runDeleteMonth = async () => {
    const ok = window.confirm(
      `${targetMonth} の提出・割当・公開状態をすべて削除します。検証データ整理以外では戻せません。実行しますか？`
    );
    if (!ok) {
      return;
    }
    setLoading(true);
    setNotice(null);
    try {
      const result = await deleteMonthData({ month: targetMonth, token });
      setNotice(`${targetMonth} のデータを ${result.deleted ?? 0} 件削除しました。`);
      await loadSummary();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const runPurge = async () => {
    const ok = window.confirm(
      `${cutoffMonth} より前の月のデータをすべて削除します。実行しますか？`
    );
    if (!ok) {
      return;
    }
    setLoading(true);
    setNotice(null);
    try {
      const result = await purgeOldData({ cutoffMonth, token });
      setNotice(`${cutoffMonth} より前のデータを ${result.deleted ?? 0} 件削除しました。`);
      await loadSummary();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h2>データ整理</h2>
      <p className="hint">
        検証段階で作成したデータや過去月のデータを管理者が整理する画面です。
      </p>

      <div className="controls">
        <label>
          対象月
          <select
            value={targetMonth}
            onChange={(event) => setTargetMonth(event.target.value)}
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={loadSummary} disabled={loading}>
          件数を確認
        </button>
        <button onClick={runDeleteMonth} disabled={loading || !summary?.total}>
          この月を全削除
        </button>
      </div>

      {summary ? (
        <table className="simple-table">
          <thead>
            <tr>
              <th>月</th>
              <th>提出</th>
              <th>割当</th>
              <th>公開状態</th>
              <th>その他</th>
              <th>合計</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{summary.month}</td>
              <td>{summary.submissions}</td>
              <td>{summary.assignments}</td>
              <td>{summary.publishStates}</td>
              <td>{summary.other}</td>
              <td>{summary.total}</td>
            </tr>
          </tbody>
        </table>
      ) : null}

      <div className="controls">
        <label>
          この月より前を一括削除
          <select
            value={cutoffMonth}
            onChange={(event) => setCutoffMonth(event.target.value)}
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
        </label>
        <button onClick={runPurge} disabled={loading}>
          過去データを削除
        </button>
      </div>

      <div className="controls">
        <button onClick={runBackfill} disabled={loading}>
          保持期限を補正
        </button>
      </div>

      {notice ? <div className="notice notice--success">{notice}</div> : null}
    </div>
  );
}

import React, { useEffect, useState } from "react";
import { useAuth } from "react-oidc-context";
import { fetchAdminCost, type AdminCostSummary } from "../api/adminApi";

const FALLBACK_USD_TO_JPY = 156;
const EXCHANGE_RATE_CACHE_KEY = "shift-admin-usd-jpy-rate-v1";

type ExchangeRateState = {
  rate: number;
  date: string;
  source: string;
  loading: boolean;
  error?: string;
};

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2
  }).format(value);
}

function formatJpy(value: number, usdToJpy: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0
  }).format(value * usdToJpy);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getInclusiveEndDate(periodEndExclusive: string): string {
  const end = new Date(`${periodEndExclusive}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function getJapanDateKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

async function fetchUsdToJpyRate(): Promise<ExchangeRateState> {
  const today = getJapanDateKey();
  const cached = localStorage.getItem(EXCHANGE_RATE_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as ExchangeRateState & {
        cacheDate?: string;
      };
      if (parsed.cacheDate === today && Number.isFinite(parsed.rate)) {
        return { ...parsed, loading: false };
      }
    } catch {
      localStorage.removeItem(EXCHANGE_RATE_CACHE_KEY);
    }
  }

  const response = await fetch("https://api.frankfurter.dev/v2/rate/USD/JPY");
  if (!response.ok) {
    throw new Error("為替レートの取得に失敗しました。");
  }
  const data = (await response.json()) as {
    rate?: number;
    date?: string;
    rates?: { JPY?: number };
  };
  const rate = data.rate ?? data.rates?.JPY;
  if (!Number.isFinite(rate)) {
    throw new Error("為替レートの形式が不正です。");
  }

  const result = {
    rate,
    date: data.date ?? today,
    source: "Frankfurter",
    loading: false
  };
  localStorage.setItem(
    EXCHANGE_RATE_CACHE_KEY,
    JSON.stringify({ ...result, cacheDate: today })
  );
  return result;
}

export default function CostPage() {
  const auth = useAuth();
  const token = auth.user?.id_token || auth.user?.access_token || "";
  const [summary, setSummary] = useState<AdminCostSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exchangeRate, setExchangeRate] = useState<ExchangeRateState>({
    rate: FALLBACK_USD_TO_JPY,
    date: getJapanDateKey(),
    source: "fallback",
    loading: true
  });

  const load = async () => {
    setLoading(true);
    setNotice(null);
    try {
      setSummary(await fetchAdminCost({ token }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchUsdToJpyRate()
      .then((result) => {
        if (!cancelled) {
          setExchangeRate(result);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setExchangeRate({
            rate: FALLBACK_USD_TO_JPY,
            date: getJapanDateKey(),
            source: "fallback",
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const endDate = summary
    ? getInclusiveEndDate(summary.periodEndExclusive)
    : null;
  const realtime = summary?.realtimeEstimate;
  const usdToJpy = exchangeRate.rate;

  return (
    <div>
      <h2>コスト確認</h2>
      <p className="hint">
        Cost Explorerの請求実績と、CloudWatchメトリクスから計算したリアルタイム推定額を確認します。
      </p>

      <div className="controls">
        <button onClick={load} disabled={loading}>
          最新の請求データを取得
        </button>
        {summary ? (
          <span className="hint">
            最終取得: {formatDateTime(summary.updatedAt)}
          </span>
        ) : null}
      </div>

      {notice ? <div className="notice notice--error">{notice}</div> : null}

      {summary ? (
        <>
          <div className="metric-grid">
            <section className="metric-card">
              <div className="metric-label">今月実績</div>
              <div className="metric-value">{formatUsd(summary.actualUsd)}</div>
              <div className="metric-subvalue">
                {formatJpy(summary.actualUsd, usdToJpy)}
              </div>
            </section>
            <section className="metric-card metric-card--live">
              <div className="metric-label">リアルタイム推定</div>
              <div className="metric-value">
                {formatUsd(realtime?.estimatedUsd ?? 0)}
              </div>
              <div className="metric-subvalue">
                {formatJpy(realtime?.estimatedUsd ?? 0, usdToJpy)}
              </div>
            </section>
            <section className="metric-card">
              <div className="metric-label">推定月末予測</div>
              <div className="metric-value">
                {formatUsd(realtime?.projectedUsd ?? summary.projectedUsd)}
              </div>
              <div className="metric-subvalue">
                {formatJpy(
                  realtime?.projectedUsd ?? summary.projectedUsd,
                  usdToJpy
                )}
              </div>
            </section>
            <section className="metric-card">
              <div className="metric-label">集計期間</div>
              <div className="metric-value metric-value--small">
                {formatDate(summary.periodStart)} - {endDate ? formatDate(endDate) : "-"}
              </div>
              <div className="metric-subvalue">
                {summary.elapsedDays}日 / {summary.daysInMonth}日
              </div>
            </section>
          </div>

          <div className="formula-box">
            <strong>計算式</strong>
            <div>リアルタイム推定 = CloudWatch利用量 × 概算単価</div>
            <div>推定月末予測 = リアルタイム推定 ÷ 経過時間 × 月の時間</div>
            <div>Cost Explorer月末予測 = 今月実績 ÷ 経過日数 × 月の日数</div>
            <div>
              円換算 = USD × {usdToJpy.toLocaleString("ja-JP")}円
              （{exchangeRate.source} / {exchangeRate.date}）
            </div>
            <div className="hint">
              Cost Explorerの請求データには反映遅延があるため、完全なリアルタイム料金ではありません。
              無料枠や調整額により、サービス別内訳には小さなマイナス額が出る場合があります。
              {exchangeRate.error
                ? ` 為替取得に失敗したため暫定レートを使用しています: ${exchangeRate.error}`
                : ""}
              {realtime?.wafEnabled === false
                ? " AWS WAFは現在無効のため、リアルタイム推定にはWAF固定費を含めていません。"
                : ""}
              {realtime?.pricing.label ? ` ${realtime.pricing.label}` : ""}
            </div>
          </div>

          <h3>リアルタイム推定内訳</h3>
          <table className="simple-table">
            <thead>
              <tr>
                <th>サービス</th>
                <th>推定USD</th>
                <th>円換算</th>
                <th>利用量</th>
                <th>補足</th>
              </tr>
            </thead>
            <tbody>
              {realtime?.services.length ? (
                realtime.services.map((service) => (
                  <tr key={service.service}>
                    <td>{service.service}</td>
                    <td>{formatUsd(service.amountUsd)}</td>
                    <td>{formatJpy(service.amountUsd, usdToJpy)}</td>
                    <td>
                      {service.usage.toLocaleString("ja-JP")} {service.unit}
                    </td>
                    <td>{service.detail}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5}>リアルタイム推定データはまだありません。</td>
                </tr>
              )}
            </tbody>
          </table>

          <h3>Cost Explorer内訳</h3>
          <table className="simple-table">
            <thead>
              <tr>
                <th>サービス</th>
                <th>USD</th>
                <th>円換算</th>
              </tr>
            </thead>
            <tbody>
              {summary.services.length ? (
                summary.services.map((service) => (
                  <tr key={service.service}>
                    <td>{service.service}</td>
                    <td>{formatUsd(service.amountUsd)}</td>
                    <td>{formatJpy(service.amountUsd, usdToJpy)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3}>今月の課金データはまだありません。</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      ) : loading ? (
        <div className="notice">読み込み中...</div>
      ) : null}
    </div>
  );
}

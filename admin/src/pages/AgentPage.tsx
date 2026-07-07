import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState
} from "react";
import { useAuth } from "react-oidc-context";
import { askAdminAgent, type AdminAgentResponse } from "../api/adminApi";
import { defaultOperationalMonth, monthOptions } from "../utils/monthOptions";
import { renderMarkdownText } from "../utils/markdown";

type Message = {
  role: "user" | "assistant";
  text: string;
  meta?: string;
};

const months = monthOptions({ past: 12, future: 3 });
const DEFAULT_QUESTION =
  "今月のシフトについて、人手不足、勤務の偏り、修正案を教えて";

export default function AgentPage() {
  const auth = useAuth();
  const token = auth.user?.id_token || auth.user?.access_token || "";
  const initialMonth = defaultOperationalMonth();
  const [month, setMonth] = useState(
    months.some((item) => item.value === initialMonth)
      ? initialMonth
      : months[months.length - 1].value
  );
  const [minStaffPerSlot, setMinStaffPerSlot] = useState(2);
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [latestResult, setLatestResult] = useState<AdminAgentResponse | null>(
    null
  );
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text:
        "シフト状況について自然文で質問できます。Geminiには匿名化した集計データだけを送信します。"
    }
  ]);
  const chatRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = chatRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [messages, loading]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || loading) {
      return;
    }
    if (!token) {
      setError("認証情報が見つかりません。");
      return;
    }

    setLoading(true);
    setError("");
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);

    try {
      const result = await askAdminAgent({
        token,
        month,
        question: trimmed,
        minStaffPerSlot
      });
      setLatestResult(result);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: result.answer,
          meta: `${result.model} / 匿名化済み`
        }
      ]);
      setQuestion("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `回答生成に失敗しました。\n${message}`
        }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const askPreset = (text: string) => {
    setQuestion(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <div className="agent-page">
      <div className="agent-topbar">
        <div>
          <h2>AIアシスタント</h2>
          <div className="agent-status">
            <span>Gemini</span>
            <span>匿名化済み</span>
          </div>
        </div>
        <div className="agent-controls">
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
            最低人数
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
        </div>
      </div>

      {error ? <div className="notice notice--error">{error}</div> : null}

      <div className="agent-presets">
        {[
          "人手不足の時間帯と追加候補を教えて",
          "勤務回数が偏っているスタッフを教えて",
          "希望外の割当がないか確認して",
          "店長が今すぐ直すべき点を優先順で教えて"
        ].map((item) => (
          <button key={item} type="button" onClick={() => askPreset(item)}>
            {item}
          </button>
        ))}
      </div>

      <div ref={chatRef} className="agent-chat" aria-live="polite">
        {messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={`agent-message agent-message--${message.role}`}
          >
            <div className="agent-message__role">
              {message.role === "user" ? "質問" : "回答"}
              {message.meta ? (
                <span className="agent-message__meta">{message.meta}</span>
              ) : null}
            </div>
            <div className="agent-message__text markdown-body">
              {message.role === "assistant"
                ? renderMarkdownText(message.text)
                : message.text}
            </div>
          </div>
        ))}
        {loading ? (
          <div className="agent-message agent-message--assistant">
            <div className="agent-message__role">回答</div>
            <div className="agent-message__text">Geminiで回答を生成しています...</div>
          </div>
        ) : null}
      </div>

      <div className="agent-footer">
        <div className="agent-metrics">
          <div>
            <span>提出者</span>
            <strong>{latestResult?.totals.submissions ?? "-"}</strong>
          </div>
          <div>
            <span>スタッフ</span>
            <strong>{latestResult?.totals.staff ?? "-"}</strong>
          </div>
          <div>
            <span>割当</span>
            <strong>{latestResult?.totals.assignments ?? "-"}</strong>
          </div>
          <div>
            <span>時間帯</span>
            <strong>{latestResult?.totals.slots ?? "-"}</strong>
          </div>
        </div>

        <form className="agent-input" onSubmit={ask}>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="例: 土日の夜で人手不足の時間帯と修正案を教えて"
            rows={2}
          />
          <button type="submit" disabled={loading || !question.trim()}>
            {loading ? "生成中" : "送信"}
          </button>
        </form>
      </div>
    </div>
  );
}

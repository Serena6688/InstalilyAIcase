"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MessageBubble from "./MessageBubble";
import PartCard from "./PartCard";
import SourceBar from "./SourceBar";

type Role = "user" | "assistant";
type ChatMessage = { role: Role; content: string };

type PartCardType = {
  type: "part";
  partNumber: string;
  name: string;
  price?: string;
  imageUrl?: string;
  compatibleModels?: string[];
};

type ChatMeta = {
  inDomain?: boolean;
  intent?: string;
  extracted?: {
    partNumber?: string;
    modelNumber?: string;
    appliance?: "dishwasher" | "refrigerator" | string;
    symptom?: string;
  };
  toolsUsed?: string[];
  sources?: Array<{ label: string; uri?: string }>;
  error?: string;
};

type ChatResponse = {
  reply: string;
  meta?: ChatMeta;
  cards?: PartCardType[];
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8080";
const COMPOSER_SAFE_AREA_PX = 200;

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Hi! I can help with **refrigerator and dishwasher parts** on PartSelect — part info, compatibility, installation, and troubleshooting.\n\nTry: “Is PS11752778 compatible with my WDT780SAEM1 model?”",
    },
  ]);

  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);

  const [lastMeta, setLastMeta] = useState<ChatMeta | null>(null);
  const [lastSources, setLastSources] = useState<ChatMeta["sources"]>([]);
  const [lastCards, setLastCards] = useState<PartCardType[]>([]);

  const [debugOpen, setDebugOpen] = useState(false);

  // ✅ Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function showToast(msg: string) {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 2000);
  }

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, lastCards]);

  const canSend = useMemo(() => input.trim().length > 0 && !isSending, [input, isSending]);

  const hasChatted = useMemo(() => messages.some((m) => m.role === "user"), [messages]);

  const quickActions = useMemo(() => {
    const intent = lastMeta?.intent ?? "";
    const part = lastMeta?.extracted?.partNumber;
    const model = lastMeta?.extracted?.modelNumber;
    const appliance = lastMeta?.extracted?.appliance;

    const actions: Array<{
      key: string;
      label: string;
      prompt?: string;
      kind?: "primary" | "default";
      action?: "toast_add_to_cart";
    }> = [];

    if (part && model) {
      actions.push({
        key: "compat",
        label: "Re-check compatibility",
        prompt: `Is ${part} compatible with my ${model} model?`,
        kind: "primary",
      });
    } else if (part) {
      actions.push({
        key: "compat2",
        label: "Check compatibility",
        prompt: `Is ${part} compatible with my model? (My model number is ...)`,
        kind: "primary",
      });
    }

    if (part) {
      actions.push({
        key: "install",
        label: "Installation steps",
        prompt: `How can I install part number ${part}?`,
        kind: intent === "compatibility_check" ? "default" : "primary",
      });
    } else {
      actions.push({
        key: "install2",
        label: "Installation help",
        prompt: `How can I install part number PS11752778?`,
      });
    }

    actions.push({
      key: "trouble",
      label: "Troubleshoot",
      prompt:
        appliance === "refrigerator"
          ? "My refrigerator is not cooling properly. How can I troubleshoot it?"
          : "My dishwasher is not draining. How can I troubleshoot it?",
    });

    if (part) {
      actions.push({
        key: "alts",
        label: "Find alternatives",
        prompt: `Are there alternative parts to ${part} that work for my model?`,
      });

      // ✅ Add to cart = toast demo (no backend call)
      actions.push({
        key: "cart",
        label: "Add to cart (demo)",
        action: "toast_add_to_cart",
      });
    }

    const uniq = new Map<string, (typeof actions)[number]>();
    for (const a of actions) uniq.set(a.key, a);
    return Array.from(uniq.values()).slice(0, 5);
  }, [lastMeta]);

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    if (!text || isSending) return;

    setInput("");
    setIsSending(true);
    setLastSources([]);
    setLastCards([]);
    setLastMeta(null);

    const newHistory = [...messages, { role: "user", content: text }];
    setMessages(newHistory);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: newHistory }),
      });

      const data = (await res.json()) as ChatResponse;

      setMessages((prev) => [...prev, { role: "assistant", content: data.reply ?? "Sorry — no response." }]);

      const meta = data.meta ?? {};
      setLastMeta(meta);
      setLastSources(meta.sources ?? []);
      setLastCards(data.cards ?? []);
    } catch {
      const fallback: ChatMeta = { inDomain: true, intent: "unknown", error: "network_error" };
      setLastMeta(fallback);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "I couldn’t reach the server. Is the backend running on port 8080?" },
      ]);
    } finally {
      setIsSending(false);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  const suggested = [
    "How can I install part number PS11752778?",
    "Is PS11752778 compatible with my WDT780SAEM1 model?",
    "The ice maker on my Whirlpool fridge is not working. How can I fix it?",
  ];

  const extractedPart = lastMeta?.extracted?.partNumber;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 20 }}>
      {/* Header */}
      <div
        style={{
          background: "#fff",
          border: "1px solid var(--border, #E5E7EB)",
          borderRadius: 16,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          boxShadow: "0 1px 8px rgba(0,0,0,0.04)",
          gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, color: "#111827" }}>PartSelect Copilot</div>
          <div style={{ color: "var(--muted, #6B7280)", fontSize: 13 }}>
            Find compatible parts. Get install steps. Fix issues faster.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <div style={{ color: "var(--muted, #6B7280)", fontSize: 12 }}>
            Backend:{" "}
            <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: "#374151" }}>
              {API_BASE}
            </span>
          </div>

          <button
            onClick={() => setDebugOpen((v) => !v)}
            style={{
              border: "1px solid var(--border, #E5E7EB)",
              background: debugOpen ? "#F3F4F6" : "#fff",
              borderRadius: 999,
              padding: "6px 10px",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
              color: "#374151",
            }}
            title="Toggle debug info (intent/extracted/tools)"
          >
            {debugOpen ? "Debug: ON" : "Debug"}
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        style={{
          marginTop: 12,
          background: "#fff",
          border: "1px solid var(--border, #E5E7EB)",
          borderRadius: 16,

          // ✅ changed: reduce “empty huge box” feeling on first load,
          // while keeping scroll once chat grows.
          minHeight: 420,
          maxHeight: "72vh",

          overflowY: "auto",
          padding: 16,
          paddingBottom: COMPOSER_SAFE_AREA_PX,
          boxShadow: "0 1px 8px rgba(0,0,0,0.04)",
        }}
      >
        {messages.map((m, idx) => (
          <MessageBubble key={idx} role={m.role} content={m.content} />
        ))}

        {isSending && <MessageBubble role="assistant" content="Thinking…" />}

        {/* Quick Actions */}
        {messages.length > 0 && messages[messages.length - 1]?.role === "assistant" && quickActions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#6B7280", marginBottom: 8 }}>
              Suggested next steps
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {quickActions.map((a) => (
                <button
                  key={a.key}
                  onClick={() => {
                    if (a.action === "toast_add_to_cart") {
                      const p = extractedPart ?? "this part";
                      showToast(`✅ Demo: added ${p} to cart`);
                      return;
                    }
                    if (a.prompt) void send(a.prompt);
                  }}
                  style={{
                    border: a.kind === "primary" ? "1px solid #2563EB" : "1px solid #D1D5DB",
                    background: a.kind === "primary" ? "#2563EB" : "#fff",
                    color: a.kind === "primary" ? "#fff" : "#374151",
                    borderRadius: 999,
                    padding: "8px 10px",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 700,
                  }}
                  title={a.prompt ?? a.label}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Cards */}
        {lastCards.length > 0 && (
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {lastCards.map((c, i) => (
              <PartCard
                key={i}
                card={c}
                onAddToCart={(partNumber) => showToast(`✅ Demo: added ${partNumber} to cart`)}
                onViewDetails={(partNumber) => showToast(`🔎 Demo: would open details for ${partNumber}`)}
              />
            ))}
          </div>
        )}

        {/* Sources */}
        {lastSources && lastSources.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <SourceBar sources={lastSources} />
          </div>
        )}

        {/* Debug Drawer */}
        {debugOpen && (
          <div
            style={{
              marginTop: 12,
              border: "1px solid var(--border, #E5E7EB)",
              borderRadius: 14,
              padding: 12,
              background: "#FAFAFB",
              color: "#111827",
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 8 }}>Debug</div>
            <div style={{ display: "grid", gap: 8, fontSize: 12 }}>
              <Row k="intent" v={lastMeta?.intent ?? "(none)"} />
              <Row k="inDomain" v={String(lastMeta?.inDomain ?? "(unknown)")} />
              <Row
                k="extracted"
                v={lastMeta?.extracted ? JSON.stringify(lastMeta.extracted, null, 2) : "(none)"}
                mono
                pre
              />
              <Row
                k="toolsUsed"
                v={lastMeta?.toolsUsed?.length ? lastMeta.toolsUsed.join(", ") : "(none)"}
                mono
              />
              <Row
                k="sources"
                v={lastMeta?.sources?.length ? lastMeta.sources.map((s) => s.label).join(" | ") : "(none)"}
              />
              {lastMeta?.error && <Row k="error" v={lastMeta.error} mono />}
            </div>
          </div>
        )}
      </div>

      {/* Sticky Composer */}
      <div
        style={{
          position: "sticky",
          bottom: 0,
          marginTop: 12,
          paddingTop: 10,
          paddingBottom: 12,
          background: "linear-gradient(to top, rgba(247,247,248,1) 60%, rgba(247,247,248,0))",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            background: "#fff",
            border: "1px solid var(--border, #E5E7EB)",
            borderRadius: 16,
            padding: 12,
            boxShadow: "0 1px 8px rgba(0,0,0,0.04)",
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask about a part number (PS...), model compatibility, installation, or troubleshooting…"
            style={{
              flex: 1,
              border: "1px solid var(--border, #E5E7EB)",
              borderRadius: 12,
              padding: "12px 12px",
              fontSize: 14,
              outline: "none",
              color: "#111827",
              background: "#fff",
              minWidth: 0,
            }}
          />
          <button
            onClick={() => void send()}
            disabled={!canSend}
            style={{
              border: "none",
              borderRadius: 12,
              padding: "12px 14px",
              fontWeight: 800,
              cursor: canSend ? "pointer" : "not-allowed",
              background: canSend ? "var(--brand, #2563EB)" : "#E5E7EB",
              color: canSend ? "#fff" : "#6B7280",
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>

        {/* ✅ changed: show suggested prompts ONLY before user starts chatting,
            so you don't get duplicate “suggested” sections. */}
        {!hasChatted && (
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {suggested.map((p) => (
              <button
                key={p}
                onClick={() => void send(p)}
                style={{
                  border: "1px solid #D1D5DB",
                  background: "#fff",
                  borderRadius: 999,
                  padding: "8px 10px",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 700,
                  color: "#374151",
                }}
                title={p}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        <style jsx>{`
          input::placeholder {
            color: #9ca3af;
          }
        `}</style>
      </div>

      {/* ✅ Toast */}
      {toastMessage && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            bottom: 22,
            transform: "translateX(-50%)",
            background: "rgba(17,24,39,0.92)",
            color: "#fff",
            padding: "10px 14px",
            borderRadius: 12,
            fontSize: 13,
            fontWeight: 800,
            boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
            zIndex: 9999,
            maxWidth: 520,
          }}
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}

function Row(props: { k: string; v: string; mono?: boolean; pre?: boolean }) {
  const { k, v, mono, pre } = props;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 10, alignItems: "start" }}>
      <div style={{ fontWeight: 900, color: "#374151" }}>{k}</div>
      <div
        style={{
          fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
          whiteSpace: pre ? "pre-wrap" : "normal",
          color: "#111827",
        }}
      >
        {v}
      </div>
    </div>
  );
}
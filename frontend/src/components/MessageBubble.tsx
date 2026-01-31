"use client";

function renderSimpleMarkdown(text: string) {
  // minimal bold support: **text**
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return <strong key={i}>{p.slice(2, -2)}</strong>;
    }
    // keep newlines
    return (
      <span key={i}>
        {p.split("\n").map((line, j) => (
          <span key={j}>
            {line}
            {j < p.split("\n").length - 1 ? <br /> : null}
          </span>
        ))}
      </span>
    );
  });
}

export default function MessageBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 10 }}>
      <div
        style={{
          maxWidth: "78%",
          padding: "10px 12px",
          borderRadius: 14,
          border: "1px solid var(--border)",
          background: isUser ? "#e8f0ff" : "#fff",
          color: "#111827",
          whiteSpace: "pre-wrap",
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.45 }}>{renderSimpleMarkdown(content)}</div>
      </div>
    </div>
  );
}
"use client";

type Source = { label: string; uri?: string };

export default function SourceBar({ sources }: { sources: Source[] }) {
  const deduped = Array.from(
    new Map(sources.map((s) => [`${s.label}|${s.uri ?? ""}`, s])).values()
  );

  return (
    <div style={{ fontSize: 12, color: "var(--muted)" }}>
      <strong>Sources</strong>
      <ul style={{ marginTop: 4 }}>
        {deduped.map((s, i) => (
          <li key={i}>
            {s.uri ? (
              <a href={s.uri} target="_blank" rel="noreferrer">
                {s.label}
              </a>
            ) : (
              s.label
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
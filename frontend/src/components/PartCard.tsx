"use client";

import { useState } from "react";

type PartCardType = {
  type: "part";
  partNumber: string;
  name: string;
  price?: string;
  imageUrl?: string;
  compatibleModels?: string[];
};

export default function PartCard(props: {
  card: PartCardType;
  onAddToCart?: (partNumber: string) => void;
  onViewDetails?: (partNumber: string) => void;
}) {
  const { card, onAddToCart, onViewDetails } = props;

  const placeholder = "/placeholder-part.png";
  const [imgSrc, setImgSrc] = useState<string>(card.imageUrl || placeholder);

  return (
    <div
      style={{
        border: "1px solid var(--border, #E5E7EB)",
        borderRadius: 16,
        padding: 14,
        display: "flex",
        gap: 14,
        alignItems: "center",
        background: "#fff",
      }}
    >
      {/* Image */}
      <div
        style={{
          width: 76,
          height: 76,
          borderRadius: 12,
          border: "1px solid var(--border, #E5E7EB)",
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#F9FAFB",
          flexShrink: 0,
        }}
      >
        <img
          src={imgSrc}
          alt={card.partNumber}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
          onError={() => setImgSrc(placeholder)}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 900, color: "#111827" }}>{card.name}</div>

        <div style={{ marginTop: 4, color: "var(--muted, #6B7280)", fontSize: 13 }}>
          Part: <span style={{ fontWeight: 800, color: "#111827" }}>{card.partNumber}</span>
          {card.price ? (
            <>
              {" "}
              • <span style={{ fontWeight: 800, color: "#111827" }}>{card.price}</span>
            </>
          ) : null}
        </div>

        {card.compatibleModels && card.compatibleModels.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <div style={{ color: "var(--muted, #6B7280)", fontWeight: 800, marginBottom: 4 }}>
              Compatible models (sample)
            </div>
            <div style={{ color: "#374151", lineHeight: 1.35 }}>
              {card.compatibleModels.slice(0, 6).join(", ")}
              {card.compatibleModels.length > 6 ? " …" : ""}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <button
          onClick={() => onViewDetails?.(card.partNumber)}
          disabled={!onViewDetails}
          style={{
            border: "1px solid var(--border, #E5E7EB)",
            borderRadius: 12,
            padding: "10px 12px",
            fontWeight: 800,
            cursor: onViewDetails ? "pointer" : "not-allowed",
            background: onViewDetails ? "#fff" : "#F3F4F6",
            color: onViewDetails ? "#374151" : "#9CA3AF",
          }}
        >
          View details
        </button>

        <button
          onClick={() => onAddToCart?.(card.partNumber)}
          disabled={!onAddToCart}
          style={{
            border: "none",
            borderRadius: 12,
            padding: "10px 12px",
            fontWeight: 900,
            cursor: onAddToCart ? "pointer" : "not-allowed",
            background: onAddToCart ? "var(--brand, #2563EB)" : "#E5E7EB",
            color: onAddToCart ? "#fff" : "#9CA3AF",
          }}
        >
          Add to cart
        </button>
      </div>
    </div>
  );
}
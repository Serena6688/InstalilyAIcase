const DOMAIN_KEYWORDS = [
  "partselect",
  "refrigerator",
  "fridge",
  "dishwasher",
  "ice maker",
  "icemaker",
  "water filter",
  "drain pump",
  "spray arm",
  "whirlpool",
  "ge",
  "frigidaire",
  "bosch",
  "kenmore",
  "kitchenaid",
  "maytag",
  "amana",
  "ps", // part numbers like PS11752778
  "wdt", // model numbers like WDT780SAEM1
];

const OUT_OF_SCOPE_HINTS = [
  "politics",
  "stock",
  "movie",
  "relationship",
  "homework",
  "leetcode",
  "visa",
];

export function isInDomain(query: string): boolean {
  const q = query.toLowerCase();

  if (OUT_OF_SCOPE_HINTS.some((k) => q.includes(k))) return false;

  // PartSelect part number pattern PS########
  const hasPS = /ps\d{6,}/i.test(query);
  const hasModel = /\b[A-Z]{2,}\d{2,}[A-Z0-9]*\b/.test(query); // loose model pattern

  if (hasPS || hasModel) return true;
  return DOMAIN_KEYWORDS.some((k) => q.includes(k));
}

export function outOfScopeReply(): string {
  return [
    "I can help with PartSelect-related questions for **refrigerator and dishwasher parts** — like part info, compatibility, installation, and troubleshooting.",
    "If you share your **part number (e.g., PS11752778)** and/or **model number**, I’ll help you from there.",
  ].join("\n");
}
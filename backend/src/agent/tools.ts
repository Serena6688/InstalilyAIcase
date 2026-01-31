import fs from "fs";
import path from "path";

export type Part = {
  partNumber: string;
  name: string;
  price?: string;
  imageUrl?: string;
  appliance?: "refrigerator" | "dishwasher" | "unknown";
  compatibleModels?: string[];
};

export type CompatibilityRow = {
  partNumber: string;
  models: string[];
};

export type Guide = {
  id?: string;
  title: string;
  url?: string;
  snippet?: string;
  appliance?: "refrigerator" | "dishwasher" | "unknown";
  mode?: "install" | "troubleshoot" | "general";
  tags?: string[];
};

export type ToolResult = {
  title: string;
  data: any;
  sources?: Array<{ label: string; uri?: string }>;
};

function dataPath(file: string) {
  // backend/src/agent/tools.ts -> backend/src/data/*
  return path.join(process.cwd(), "src", "data", file);
}

function safeReadJson<T>(file: string, fallback: T): T {
  try {
    const p = dataPath(file);
    const raw = fs.readFileSync(p, "utf-8");
    if (!raw?.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Force any JSON shape to an array to prevent "list.find is not a function". */
function asArray<T>(x: any): T[] {
  if (Array.isArray(x)) return x as T[];
  if (!x) return [];
  // common pattern: { items: [...] }
  if (Array.isArray(x.items)) return x.items as T[];
  return [];
}

function norm(s: string) {
  return (s ?? "").trim().toUpperCase();
}

/** ---------- Loaders (mock data) ---------- */
function loadParts(): Part[] {
  const raw = safeReadJson<any>("parts.sample.json", []);
  const list = asArray<Part>(raw);
  return list.map((p) => ({
    ...p,
    partNumber: norm(p.partNumber),
    compatibleModels: asArray<string>((p as any).compatibleModels).map(norm),
    appliance: (p.appliance ?? "unknown") as any,
  }));
}

function loadCompatibility(): CompatibilityRow[] {
  const raw = safeReadJson<any>("compatibility.sample.json", []);
  const list = asArray<any>(raw);
  return list
    .map((r) => ({
      partNumber: norm(r.partNumber),
      models: asArray<string>(r.models).map(norm),
    }))
    .filter((r) => r.partNumber);
}

function loadGuides(): Guide[] {
  const raw = safeReadJson<any>("guides.sample.json", []);
  const list = asArray<any>(raw);
  return list.map((g) => ({
    id: g.id,
    title: String(g.title ?? "").trim(),
    url: g.url,
    snippet: g.snippet,
    appliance: (g.appliance ?? "unknown") as any,
    mode: (g.mode ?? "general") as any,
    tags: asArray<string>(g.tags ?? []),
  }));
}

/** ---------- Tools ---------- */

export function toolLookupPart(partNumber: string): ToolResult & { part?: Part } {
  const parts = loadParts();
  const pn = norm(partNumber);
  const part = parts.find((p) => norm(p.partNumber) === pn);

  return {
    title: "Part lookup",
    data: part
      ? {
          found: true,
          part,
        }
      : { found: false },
    part: part ?? undefined,
    sources: [{ label: "Sample catalog (mock data)" }],
  };
}

export function toolCheckCompatibility(partNumber: string, modelNumber: string): ToolResult & { compatible?: boolean } {
  const pn = norm(partNumber);
  const mn = norm(modelNumber);

  const compat = loadCompatibility();
  const parts = loadParts();

  // 1) Prefer compatibility index if present
  const row = compat.find((r) => r.partNumber === pn);
  if (row) {
    const ok = row.models.includes(mn);
    return {
      title: "Compatibility check",
      data: { partNumber: pn, modelNumber: mn, compatible: ok, source: "compatibility_index" },
      compatible: ok,
      sources: [{ label: "Compatibility index (mock data)" }],
    };
  }

  // 2) Fallback: if catalog includes compatibleModels, use it (keeps UI consistent)
  const part = parts.find((p) => p.partNumber === pn);
  if (part?.compatibleModels?.length) {
    const ok = part.compatibleModels.map(norm).includes(mn);
    return {
      title: "Compatibility check",
      data: { partNumber: pn, modelNumber: mn, compatible: ok, source: "catalog_fallback" },
      compatible: ok,
      sources: [{ label: "Sample catalog (mock data)" }],
    };
  }

  // 3) Unknown
  return {
    title: "Compatibility check",
    data: { partNumber: pn, modelNumber: mn, compatible: null, source: "unknown" },
    sources: [{ label: "Compatibility index (mock data)" }],
  };
}

type GuideSearchArgs = {
  query: string;
  appliance?: "refrigerator" | "dishwasher" | "unknown";
  mode?: "install" | "troubleshoot";
  topK?: number;
};

function scoreGuide(g: Guide, q: string) {
  const text = `${g.title}\n${g.snippet ?? ""}\n${(g.tags ?? []).join(" ")}`.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const t of terms) {
    if (text.includes(t)) score += 1;
  }
  return score;
}

function modeFilter(mode: "install" | "troubleshoot", g: Guide) {
  const t = `${g.title} ${g.snippet ?? ""}`.toLowerCase();

  const installHints = ["install", "replace", "remov", "mount", "screw", "panel", "disconnect power", "reconnect"];
  const troubleshootHints = ["not", "won't", "doesn't", "troubleshoot", "check", "inspect", "diagnos", "symptom", "clog", "kink", "error code", "reset"];

  const looksInstall = installHints.some((k) => t.includes(k));
  const looksTrouble = troubleshootHints.some((k) => t.includes(k));

  // if guide explicitly has mode, honor it
  if (g.mode && g.mode !== "general") {
    return g.mode === mode;
  }

  // otherwise do heuristic
  if (mode === "install") return looksInstall && !looksTrouble;
  return looksTrouble; // allow some overlap; router will format carefully
}

function dedupeGuides(guides: Guide[]) {
  const seen = new Set<string>();
  const out: Guide[] = [];
  for (const g of guides) {
    const key = (g.title ?? "").trim().toLowerCase() || (g.snippet ?? "").slice(0, 60).toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

export function toolSearchGuides(args: GuideSearchArgs): ToolResult & { guides?: Guide[] } {
  const guides = loadGuides();
  const topK = Math.max(1, Math.min(args.topK ?? 3, 6));

  const appliance = args.appliance ?? "unknown";
  const mode = args.mode;

  let pool = guides;

  // appliance filter (soft): if unknown, keep all
  if (appliance !== "unknown") {
    pool = pool.filter((g) => g.appliance === appliance || g.appliance === "unknown");
  }

  // mode filter
  if (mode) {
    pool = pool.filter((g) => modeFilter(mode, g));
  }

  // rank
  const ranked = pool
    .map((g) => ({ g, s: scoreGuide(g, args.query) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.g);

  const picked = dedupeGuides(ranked).slice(0, topK);

  return {
    title: "Guide search",
    data: { count: picked.length, mode: mode ?? "general", appliance, query: args.query, guides: picked },
    guides: picked,
    sources: [{ label: "Guide store (mock data)", uri: "https://www.partselect.com/..." }],
  };
}
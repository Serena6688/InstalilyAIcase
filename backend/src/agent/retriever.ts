import fs from "node:fs";
import path from "node:path";

export type GuideDoc = {
  id?: string;
  title?: string;
  appliance?: string;
  partNumbers?: string[];
  symptoms?: string[];
  content?: string;
  sourceLabel?: string;
  uri?: string;
};

export type RetrievedSnippet = {
  title: string;
  snippet: string;
  label: string;
  uri?: string;
  score: number;
};

type BuiltDoc = {
  raw: GuideDoc;
  tokens: string[];
  tf: Map<string, number>;
};

function safeString(x: any): string {
  if (typeof x === "string") return x;
  return "";
}

function tokenize(text: string): string[] {
  // simple tokenizer: lower, keep alnum, split
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function buildTf(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function pickSnippet(content: string, queryTokens: string[], maxLen = 260): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text) return "";

  // try to find first occurrence of any query token
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of queryTokens) {
    const i = lower.indexOf(t);
    if (i !== -1) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? "…" : "");

  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, start + maxLen);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end) + suffix;
}

export class LocalGuideRetriever {
  private docs: BuiltDoc[] = [];
  private idf = new Map<string, number>(); // token -> idf
  private ready = false;

  constructor(private guidesPath: string) {}

  init() {
    if (this.ready) return;

    const rawStr = fs.readFileSync(this.guidesPath, "utf-8");
    const arr = JSON.parse(rawStr) as GuideDoc[];

    // build docs
    const built: BuiltDoc[] = arr.map((d) => {
      const title = safeString(d.title);
      const content = safeString(d.content);
      const parts = Array.isArray(d.partNumbers) ? d.partNumbers.join(" ") : "";
      const symptoms = Array.isArray(d.symptoms) ? d.symptoms.join(" ") : "";
      const appliance = safeString(d.appliance);

      const all = [title, appliance, parts, symptoms, content].filter(Boolean).join("\n");
      const tokens = tokenize(all);
      return { raw: d, tokens, tf: buildTf(tokens) };
    });

    // compute IDF
    const df = new Map<string, number>();
    for (const b of built) {
      const uniq = new Set(b.tokens);
      for (const t of uniq) df.set(t, (df.get(t) ?? 0) + 1);
    }

    const N = built.length || 1;
    for (const [t, dfi] of df.entries()) {
      // smooth idf
      const val = Math.log((N + 1) / (dfi + 1)) + 1;
      this.idf.set(t, val);
    }

    this.docs = built;
    this.ready = true;
  }

  search(args: {
    query: string;
    topK?: number;
    appliance?: string;
    partNumber?: string;
  }): RetrievedSnippet[] {
    this.init();

    const topK = args.topK ?? 3;

    // enrich query with extracted info
    const enrich = [
      args.query,
      args.appliance ? `appliance ${args.appliance}` : "",
      args.partNumber ? `part ${args.partNumber}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const qTokens = tokenize(enrich);
    if (qTokens.length === 0) return [];

    const qtf = buildTf(qTokens);

    const scored = this.docs
      .filter((d) => {
        if (!args.appliance) return true;
        const a = safeString(d.raw.appliance).toLowerCase();
        return a.includes(args.appliance.toLowerCase());
      })
      .map((d) => {
        // cosine-like TF-IDF dot product (no norm; good enough for demo)
        let score = 0;
        for (const [t, qCount] of qtf.entries()) {
          const idf = this.idf.get(t) ?? 0;
          const docCount = d.tf.get(t) ?? 0;
          score += qCount * docCount * idf;
        }

        // small boost if doc explicitly lists the part number
        if (args.partNumber && Array.isArray(d.raw.partNumbers)) {
          if (d.raw.partNumbers.includes(args.partNumber)) score += 8;
        }

        return { d, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .filter((x) => x.score > 0);

    return scored.map(({ d, score }) => {
      const title = safeString(d.raw.title) || "Guide";
      const label = safeString(d.raw.sourceLabel) || "Guide store (mock data)";
      const content = safeString(d.raw.content);
      const snippet = pickSnippet(content, qTokens);

      return {
        title,
        snippet,
        label,
        uri: safeString(d.raw.uri) || undefined,
        score,
      };
    });
  }
}

// singleton helper (keeps it simple)
const guidesFile = path.join(process.cwd(), "src", "data", "guides.sample.json");
export const guideRetriever = new LocalGuideRetriever(guidesFile);
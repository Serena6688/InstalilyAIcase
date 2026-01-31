// backend/src/agent/groqHelpers.ts
type PumpSound = "running" | "humming" | "silent" | "unknown";

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("GROQ_TIMEOUT")), ms);
    p.then((v) => {
      clearTimeout(id);
      resolve(v);
    }).catch((e) => {
      clearTimeout(id);
      reject(e);
    });
  });
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    // 有些模型会输出 ```json ... ```，这里做个最小剥离
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalizePumpSound(x: any): PumpSound {
  const v = String(x ?? "").toLowerCase().trim();
  if (v === "running") return "running";
  if (v === "humming") return "humming";
  if (v === "silent") return "silent";
  return "unknown";
}

/**
 * Groq fallback: classify pump sound into: running | humming | silent | unknown
 * - low latency
 * - temperature 0
 * - strict JSON output (best effort)
 * - hard whitelist on return
 */
export async function groqParsePumpSound(text: string): Promise<PumpSound> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return "unknown";

  const model = process.env.GROQ_MODEL || "llama3-8b-8192"; // 你可以换成别的
  const url = "https://api.groq.com/openai/v1/chat/completions";

  const system =
    "You are a classifier. Return ONLY valid JSON. No prose, no markdown.\n" +
    'Schema: {"pump_sound": "running|humming|silent|unknown"}\n' +
    "Guidelines:\n" +
    "- running: user hears pump working / normal drain sound\n" +
    "- humming: buzzing/humming but water not moving\n" +
    "- silent: no sound / not running\n" +
    "- unknown: unclear or unrelated";

  const body = {
    model,
    temperature: 0,
    max_tokens: 30,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Text: ${text}` },
    ],
  };

  try {
    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      1200 // 1.2s 超时：MVP 先快
    );

    if (!resp.ok) return "unknown";
    const data: any = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const obj = safeJsonParse(content);
    return normalizePumpSound(obj?.pump_sound);
  } catch {
    return "unknown";
  }
}
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { handleChatTurn } from "./agent/router.js";
import type { ChatRequest, ChatResponse } from "./agent/types.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.send("OK - Backend is running. Try /health or POST /api/chat");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  try {
    const body = req.body as ChatRequest;

    if (!body?.message || typeof body.message !== "string") {
      const bad: ChatResponse = {
        reply: "Please provide a message.",
        meta: { inDomain: false, intent: "unknown" },
      };
      return res.status(400).json(bad);
    }

    const result = await handleChatTurn(body);
    return res.json(result);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error("Chat handler error:", msg, err?.stack ?? "");

    const fail: ChatResponse = {
      reply: "Sorry — something went wrong on our side.",
      meta: {
        inDomain: true,
        intent: "unknown",
        ...(process.env.NODE_ENV !== "production" ? { error: msg } : {}),
      } as any,
    };

    return res.status(500).json(fail);
  }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});
# PartSelect Parts Assistant (LLM-assisted, stateful router)

A demo backend for an **appliance parts assistant** focused on **dishwashers and refrigerators**, supporting:

youtube video link: https://youtu.be/-WGu6BZnxb0

- Part compatibility checks (PS part ↔ model)
- Step-by-step installation guidance
- Structured troubleshooting flows
- Basic order / human handoff (demo)
- **Deterministic dialog routing with selective LLM augmentation (Groq)**

This project intentionally combines **rule-based dialog control** with **LLM parsing only where it adds value**, to avoid common “chatbot drift” problems.

---

## Architecture Overview

**High-level flow**

Frontend  
→ sends `message + history`  
→ **router.ts** (main brain)

**router.ts responsibilities**
- Intent inference
- Appliance pinning (dishwasher / refrigerator)
- Dialog state tracking
- Intent stickiness (no intent stealing)

**Routing strategy**
- Deterministic dialog flows (default)
- LLM fallback (Groq) only when rule-based parsing fails

**LLM usage boundary**
- Groq is used for **narrow semantic classification**
- The LLM never controls dialog flow or routing decisions


---

## Core Concepts

### 1. Intent Stickiness (No Intent Stealing)

Short replies like:

- `panel`
- `clamps`
- `side`
- `yes`
- `totally stuck`

are **consumed by the current flow**, instead of being re-classified as new intents.

This prevents classic bugs like:
> User: *“clamps”*  
> Bot: *“Here’s part PS11752778”*

---

### 2. Appliance Pinning

The assistant infers and **pins the appliance** (dishwasher vs refrigerator) across turns, even if the user stops mentioning it explicitly.

Example:

User: My dishwasher is not draining
User: yes
User: humming

The system still knows this is a **dishwasher drain flow**.

---

### 3. Explicit Dialog State Machine

The router tracks fine-grained awaiting states such as:

- `install_step`
- `clamp_type`
- `panel_still_wont_drop_yesno`
- `connector_moving_or_stuck`
- `pump_sound`
- `dishwasher_drain_speed`

Each user reply is first offered to the **current awaiting state** before any re-routing.

---

## ⚡ Where Groq Is Used (on purpose)

Groq is **not** used to “chat”.

It is only used when:
- The system expects a specific semantic answer
- Rule-based parsing fails

### Example: Drain Pump Sound

User input:

“It makes a weird buzzing noise”

Rule-based parser → `unknown`  
Groq fallback → `"humming"`

This allows the flow to continue **without giving Groq control of the dialog**.

```ts
// router.ts
if (ps === "unknown") {
  const llm = await groqParsePumpSound(message);
  if (llm !== "unknown") ps = llm;
}


⸻

Project Structure

src/
├─ router.ts          # main dialog router & state machine
├─ groqHelpers.ts     # narrow LLM helpers (classification only)
├─ tools.ts           # demo tools (compatibility, lookup, guides)
├─ types.ts           # ChatRequest / ChatResponse / Intent


⸻

Running the Project

npm install
npm run dev

Backend runs at:

http://localhost:8080


⸻

🔑 Environment Variables

GROQ_API_KEY=your_api_key_here

If the key is missing, the system still works — Groq is optional and only used as a fallback.


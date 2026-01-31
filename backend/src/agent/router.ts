// router.ts
import type { ChatRequest, ChatResponse, ChatMessage, Intent } from "./types.js";
import { toolCheckCompatibility, toolLookupPart, toolSearchGuides } from "./tools.js";
import { groqParsePumpSound } from "./groqHelpers.js";

/** =====================================================================================
 *  Goals:
 *  1) Prevent intent stealing (e.g., "clamps" => part_lookup).
 *  2) Make follow-ups stick to the current lane unless a CLEAR shift.
 *  3) Better entity extraction (PS from link; model token robustness).
 *  4) Appliance pinning across short follow-ups.
 *  5) More complete order support branching (demo-friendly).
 *  6) Fix conversation reset / home hijack when awaiting a follow-up.
 * ===================================================================================== */

/** -------------------- Basic utils -------------------- */
function norm(s: string) {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function onlyLetters(s: string) {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function lastN(history: ChatMessage[] | undefined, n: number) {
  const h = history ?? [];
  return h.slice(Math.max(0, h.length - n));
}

function lastNUser(history: ChatMessage[] | undefined, n: number) {
  return (history ?? []).filter((m) => m.role === "user").slice(-n);
}

function lastAssistant(history: ChatMessage[] | undefined): ChatMessage | undefined {
  const h = history ?? [];
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].role === "assistant") return h[i];
  }
  return undefined;
}

/**
 * Frontend may send history INCLUDING the current user message already appended.
 * Fix: ignore the last user message if it equals current message.
 */
function countUserRepeatsExcludingCurrent(history: ChatMessage[] | undefined, current: string): number {
  const cur = norm(current);
  const h = history ?? [];
  let end = h.length;

  if (end > 0) {
    const last = h[end - 1];
    if (last.role === "user" && norm(last.content) === cur) end -= 1;
  }

  let c = 0;
  for (let i = 0; i < end; i++) {
    const m = h[i];
    if (m.role === "user" && norm(m.content) === cur) c++;
  }
  return c;
}

/** -------------------- Entity extraction -------------------- */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// allow link forms like .../PS11752778 or ?part=PS117...
const PS_IN_URL_RE = /(PS\d{5,10})/i;

// Model token: allow hyphen/underscore, but keep bounded to avoid garbage
// Examples: WDT780SAEM1, KDFE104HPS0, RF28R7351SG/AA -> we pick main chunk
const MODEL_TOKEN_RE = /\b[A-Z0-9][A-Z0-9_-]{4,23}\b/g;

function extractEmail(text: string): string | undefined {
  const m = (text ?? "").match(EMAIL_RE);
  return m?.[0];
}

function stripEmails(text: string): string {
  return (text ?? "").replace(EMAIL_RE, " ");
}

/** Extract PS from plain text */
function extractPartNumber(text: string): string | undefined {
  const up = (text ?? "").toUpperCase();
  const m = up.match(/\bPS\d{5,10}\b/);
  return m?.[0];
}

/** Extract short token like PS12 / PS1234 (incomplete) */
function extractShortPartToken(text: string): string | undefined {
  const up = (text ?? "").toUpperCase();
  const m = up.match(/\bPS\d{1,4}\b/);
  return m?.[0];
}

/** Extract PS from PartSelect link or arbitrary URL-ish text */
function extractPartNumberFromLinkOrText(text: string): string | undefined {
  const direct = extractPartNumber(text);
  if (direct) return direct;

  const m = (text ?? "").match(PS_IN_URL_RE);
  if (m?.[1]) return m[1].toUpperCase();

  return undefined;
}

/** crude URL check */
function looksLikeUrl(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  return t.includes("http://") || t.includes("https://") || t.includes("www.") || t.includes(".com/") || t.includes(".net/");
}

/** Model number heuristics */
function looksLikeRealModelToken(x: string | undefined): boolean {
  if (!x) return false;
  const bad = new Set(["NUMBER", "MODEL", "UNKNOWN", "N/A", "NULL", "NONE", "HELLO", "THANKS"]);
  if (bad.has(x)) return false;
  if (x.length < 5) return false;

  // must have at least one digit and one letter (common for appliance model numbers)
  if (!/[A-Z]/.test(x) || !/\d/.test(x)) return false;

  // avoid PS-like
  if (x.startsWith("PS")) return false;

  // avoid pure serial-looking long digits
  if (/^\d{8,}$/.test(x)) return false;

  return true;
}

/**
 * Extract model number:
 * - supports "Model: WDT780SAEM1"
 * - supports tokens like "RF28R7351SG-AA" -> pick main chunk before slash
 */
function extractModelNumber(text: string): string | undefined {
  const scrubbed = stripEmails(text);
  const up = scrubbed.toUpperCase();

  // "MODEL NUMBER IS: XXXXX"
  const m = up.match(/\bMODEL\s*(NUMBER)?\s*(IS|:)?\s*([A-Z0-9][A-Z0-9_-]{2,24})\b/);
  if (m?.[3]) {
    const token = m[3].split("/")[0].split("\\")[0];
    if (!token.startsWith("PS") && looksLikeRealModelToken(token)) return token;
  }

  // scan candidates
  const cands = up.match(MODEL_TOKEN_RE) ?? [];
  for (const raw of cands) {
    const token = raw.split("/")[0].split("\\")[0];
    if (!looksLikeRealModelToken(token)) continue;

    // avoid common noise tokens
    if (token === "DRAIN" || token === "INSTALL" || token === "REFUND" || token === "RETURN") continue;

    return token;
  }

  return undefined;
}

/** Appliance inference */
type Appliance = "refrigerator" | "dishwasher" | "unknown";

function inferApplianceFromText(text: string): Appliance {
  const t = (text ?? "").toLowerCase();

  // dishwasher strong signals
  if (
    t.includes("dishwasher") ||
    t.includes("wdt") ||
    t.includes("kdf") ||
    t.includes("not draining") ||
    t.includes("drain") ||
    t.includes("spray arm") ||
    t.includes("sump") ||
    t.includes("air gap") ||
    t.includes("high loop")
  ) {
    return "dishwasher";
  }

  // refrigerator strong signals (avoid bare "ice" because it's too generic)
  if (
    t.includes("fridge") ||
    t.includes("refrigerator") ||
    t.includes("freezer") ||
    t.includes("ice maker") ||
    t.includes("icemaster") ||
    t.includes("defrost") ||
    t.includes("evaporator") ||
    t.includes("not cooling")
  ) {
    return "refrigerator";
  }

  return "unknown";
}

/** "alternatives" intent */
function wantsAlternatives(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  return t.includes("alternative") || t.includes("alternatives") || t.includes("substitute") || t.includes("replace with") || t.includes("other option");
}

/** Human handoff intent */
function wantsHuman(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  return (
    t.includes("human") ||
    t.includes("real person") ||
    t.includes("live agent") ||
    t.includes("agent") ||
    t.includes("representative") ||
    t.includes("customer service") ||
    t.includes("support") ||
    t.includes("talk to someone") ||
    t.includes("live chat")
  );
}

function looksLikeSmallTalk(text: string): boolean {
  const t = norm(text);
  return t === "hi" || t === "hello" || t === "help" || t === "hello?" || t === "hey" || t === "hello world" || t === "confused";
}

function looksLikeAck(text: string): boolean {
  const t = onlyLetters(text);
  return t === "ok" || t === "okay" || t === "k" || t === "kk" || t === "thanks" || t === "thankyou" || t === "thx" || t === "cool" || t === "gotit" || t === "great" || t === "nice" || t === "perfect";
}

/** -------------------- Order support extraction -------------------- */
const ORDER_RE = /\b(ORD|ORDER)\s*#?\s*([A-Z0-9-]{5,20})\b/i;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

function extractOrderId(text: string): string | undefined {
  const m = (text ?? "").match(ORDER_RE);
  if (m?.[2]) return m[2].toUpperCase();
  return undefined;
}

function extractZip(text: string): string | undefined {
  const m = (text ?? "").match(ZIP_RE);
  return m?.[0];
}

function wantsReturnRefundShipping(text: string): boolean {
  const t = (text ?? "").toLowerCase();
  return t.includes("order") || t.includes("shipping") || t.includes("deliver") || t.includes("delivery") || t.includes("return") || t.includes("refund") || t.includes("exchange");
}

/** -------------------- Intent inference -------------------- */
const INTENT_KEYWORDS_RE =
  /\b(compatibility|compatible|install|installation|troubleshoot|troubleshooting|order|shipping|return|refund|human|agent|representative|customer service|support)\b/i;

function hasGlobalIntentKeyword(text: string): boolean {
  return INTENT_KEYWORDS_RE.test(text ?? "");
}

/**
 * install intent must beat "PS => part_lookup"
 * Order: human > install > compatibility > part_lookup > order > troubleshooting
 */
function inferIntent(text: string): Intent {
  const t = (text ?? "").toLowerCase();

  // highest-level: explicit human request
  if (wantsHuman(t)) return "order_support";

  // install FIRST (even if PS is present)
  if (
    t.includes("install") ||
    t.includes("how do i install") ||
    t.includes("installation") ||
    t.includes("replacement") ||
    t.includes("replace") ||
    t.includes("remove") ||
    t.includes("swap")
  ) {
    return "installation_help";
  }

  // compatibility
  if (t.includes("compatible") || t.includes("compatibility") || t.includes("fit my model") || t.includes("fits my model")) return "compatibility_check";

  // part_lookup: alternatives or explicit PS/link
  if (wantsAlternatives(t)) return "part_lookup";
  if (extractPartNumberFromLinkOrText(text)) return "part_lookup";

  // order
  if (wantsReturnRefundShipping(t) || extractOrderId(text) || extractZip(text)) return "order_support";

  // troubleshooting
  if (
    t.includes("not working") ||
    t.includes("won't") ||
    t.includes("doesn't") ||
    t.includes("troubleshoot") ||
    t.includes("fix") ||
    t.includes("not cooling") ||
    t.includes("not draining") ||
    t.includes("leak") ||
    t.includes("error code") ||
    t.includes("e:") ||
    t.includes("f:") ||
    t.includes("beeping")
  ) {
    return "troubleshooting";
  }

  return "unknown";
}

/**
 * Follow-up should be consumed unless user CLEARLY switches intent.
 */
function isClearIntentShift(text: string): boolean {
  if (!text) return false;

  if (wantsHuman(text) || wantsAlternatives(text)) return true;

  if (extractEmail(text)) return true;
  if (extractOrderId(text) || extractZip(text)) return true;

  // explicit part/model input counts as shift
  if (extractPartNumberFromLinkOrText(text)) return true;
  if (extractModelNumber(text)) return true;

  const intent = inferIntent(text);
  return intent === "compatibility_check" || intent === "installation_help" || intent === "troubleshooting" || intent === "order_support" || intent === "part_lookup";
}

/** -------------------- Session resolution (appliance-aware) -------------------- */
function messageMentionsAppliance(m: ChatMessage, appliance: Appliance) {
  if (appliance === "unknown") return true;
  const a = inferApplianceFromText(m.content);
  return a === appliance;
}

function findLastPartNumber(history: ChatMessage[] | undefined): string | undefined {
  const h = history ?? [];
  for (let i = h.length - 1; i >= 0; i--) {
    const pn = extractPartNumberFromLinkOrText(h[i]?.content ?? "");
    if (pn) return pn;
  }
  return undefined;
}

function findLastModelNumberForAppliance(history: ChatMessage[] | undefined, appliance: Appliance): string | undefined {
  const h = history ?? [];
  for (let i = h.length - 1; i >= 0; i--) {
    const msg = h[i];
    if (msg.role !== "user") continue;
    if (!messageMentionsAppliance(msg, appliance)) continue;
    const mn = extractModelNumber(msg.content ?? "");
    if (mn) return mn;
  }
  return undefined;
}

/** Appliance pinning */
function inferPinnedAppliance(message: string, history: ChatMessage[] | undefined): Appliance {
  const now = inferApplianceFromText(message);
  if (now !== "unknown") return now;

  const recent = lastNUser(history, 8);
  let dw = 0;
  let rf = 0;
  for (const m of recent) {
    const a = inferApplianceFromText(m.content);
    if (a === "dishwasher") dw++;
    if (a === "refrigerator") rf++;
  }

  if (dw === rf) return "unknown";
  return dw > rf ? "dishwasher" : "refrigerator";
}

function resolveEntities(message: string, history: ChatMessage[] | undefined, appliance: Appliance) {
  const shortPart = extractShortPartToken(message);
  const part = extractPartNumberFromLinkOrText(message);
  const model = extractModelNumber(message);

  const hasIncompletePart = !!shortPart && !part;

  // continuity for part/model, but part_lookup tool will still require explicit PS this turn
  const partNumber = part ?? (hasIncompletePart ? undefined : findLastPartNumber(history));
  const modelNumber = model ?? findLastModelNumberForAppliance(history, appliance);

  return { partNumber, modelNumber, hasIncompletePart, shortPart };
}

/** -------------------- Dialog-state -------------------- */
type Awaiting =
  | { kind: "pump_sound" }
  | { kind: "dishwasher_drain_speed" }
  | { kind: "drain_hose_setup" }
  | { kind: "sink_connection_type" }
  | { kind: "disposal_flow_yesno" }
  | { kind: "disposal_knockout_yesno" }
  | { kind: "tailpiece_gunk_yesno" }
  | { kind: "did_it_fix_yesno"; context: "drain_issue" }
  | { kind: "choice"; options: Array<"compatibility" | "install" | "symptom"> }
  | { kind: "install_step" }
  | { kind: "clamp_type" }
  | { kind: "panel_fastener" }
  | { kind: "connector_latch_side" }
  | { kind: "order_info"; ask: "order_id" | "zip" | "both" }
  | { kind: "fridge_freezer_warming_yesno" }
  | { kind: "panel_still_wont_drop_yesno" }
  | { kind: "connector_moving_or_stuck" }
  | null;

function inferDialogState(history: ChatMessage[] | undefined): Awaiting {
  const a = lastAssistant(history)?.content?.toLowerCase() ?? "";
  if (!a) return null;

  // ✅ drain speed question (standing water OR drain slowly)
  if (
    (a.includes("leaving standing water") || a.includes("standing water")) &&
    (a.includes("drain slowly") || a.includes("drains slowly") || a.includes("drain is slow") || a.includes("slow"))
  ) {
    return { kind: "dishwasher_drain_speed" };
  }
  if (a.includes("is it leaving standing water") && a.includes("or does it drain slowly")) return { kind: "dishwasher_drain_speed" };
  if (a.includes("which one is it: standing water") && a.includes("drains slowly")) return { kind: "dishwasher_drain_speed" };

  // pump sound question
  if (
    (a.includes("do you hear the drain pump") && a.includes("(yes/no)")) ||
    (a.includes("pump") && a.includes("running") && a.includes("humming") && a.includes("silent")) ||
    (a.includes("humming") && a.includes("totally silent")) ||
    (a.includes("running, humming") && a.includes("totally silent"))
  ) {
    return { kind: "pump_sound" };
  }

  if ((a.includes("high loop") || a.includes("air gap")) && a.includes("under the sink")) return { kind: "drain_hose_setup" };
  if ((a.includes("garbage disposal") || a.includes("disposal")) && a.includes("sink tailpiece")) return { kind: "sink_connection_type" };

  if (a.includes("strong water flow") && a.includes("(yes/no)")) return { kind: "disposal_flow_yesno" };
  if (a.includes("knockout plug") && a.includes("(yes/no)")) return { kind: "disposal_knockout_yesno" };
  if (a.includes("disconnect") && a.includes("tailpiece") && a.includes("(yes/no)")) return { kind: "tailpiece_gunk_yesno" };

  if ((a.includes("does it drain") || a.includes("drain normally") || a.includes("fixed")) && a.includes("(yes/no)")) {
    return { kind: "did_it_fix_yesno", context: "drain_issue" };
  }

  // choice router
  if (
    (a.includes("tell me what you want to solve") || a.includes("what you want to solve")) &&
    (a.includes("compatibility") && a.includes("install") && a.includes("symptom"))
  ) {
    return { kind: "choice", options: ["compatibility", "install", "symptom"] };
  }
  if (a.includes("compatibility/install/symptom")) return { kind: "choice", options: ["compatibility", "install", "symptom"] };

  // install chain
  if (
    a.includes("which step are you on: panel, clamps, or connector") ||
    a.includes("which step is blocking you") ||
    a.includes("which part is giving you trouble: the panel, hose clamps, or the electrical connector") ||
    (a.includes("panel") && a.includes("clamps") && a.includes("connector") && a.includes("?"))
  ) {
    return { kind: "install_step" };
  }

  if (a.includes("do you see screws") && (a.includes("clips") || a.includes("plastic clips"))) return { kind: "panel_fastener" };
  if (a.includes("spring clamp") && a.includes("screw clamp")) return { kind: "clamp_type" };
  if (a.includes("do you see a latch") && a.includes("top") && a.includes("side")) return { kind: "connector_latch_side" };
    // ✅ NEW: alternate latch phrasing
  if (a.includes("where is the latch") && a.includes("top") && a.includes("side")) {
    return { kind: "connector_latch_side" };
  }
    // ✅ NEW: panel follow-up (yes/no)
  if (a.includes("panel still won’t drop") || a.includes("panel still won't drop")) {
    return { kind: "panel_still_wont_drop_yesno" };
  }

  // ✅ NEW: connector follow-up (moving vs stuck)
  if (a.includes("is it moving at all") && a.includes("totally stuck")) {
    return { kind: "connector_moving_or_stuck" };
  }

  // order chain
  if (a.includes("order number") && a.includes("zip")) return { kind: "order_info", ask: "both" };
  if (a.includes("order number")) return { kind: "order_info", ask: "order_id" };
  if (a.includes("zip code") || a.includes("postal code")) return { kind: "order_info", ask: "zip" };
    // ✅ NEW: fridge troubleshooting follow-up
  if (a.includes("is the freezer also warming up")) {
    return { kind: "fridge_freezer_warming_yesno" };
  }

  return null;
}

function isAwaitingInstall(awaiting: Awaiting): boolean {
  if (!awaiting) return false;
  //return awaiting.kind === "install_step" || awaiting.kind === "clamp_type" || awaiting.kind === "panel_fastener" || awaiting.kind === "connector_latch_side";
  return (
  awaiting.kind === "install_step" ||
  awaiting.kind === "clamp_type" ||
  awaiting.kind === "panel_fastener" ||
  awaiting.kind === "connector_latch_side" ||
  awaiting.kind === "panel_still_wont_drop_yesno" ||
  awaiting.kind === "connector_moving_or_stuck"
  );
}

function isAwaitingTroubleshoot(awaiting: Awaiting): boolean {
  if (!awaiting) return false;
  return (
    awaiting.kind === "pump_sound" ||
    awaiting.kind === "dishwasher_drain_speed" ||
    awaiting.kind === "drain_hose_setup" ||
    awaiting.kind === "sink_connection_type" ||
    awaiting.kind === "disposal_flow_yesno" ||
    awaiting.kind === "disposal_knockout_yesno" ||
    awaiting.kind === "tailpiece_gunk_yesno" ||
    awaiting.kind === "did_it_fix_yesno"
  );
}

function isAwaitingOrder(awaiting: Awaiting): boolean {
  if (!awaiting) return false;
  return awaiting.kind === "order_info";
}

// helps prevent "clamps" being stolen by part_lookup
function isInstallQuickReply(text: string): boolean {
  const t = norm(text);
  return (
    t === "panel" ||
    t === "clamps" ||
    t === "clamp" ||
    t === "connector" ||
    t === "screws" ||
    t === "clips" ||
    t === "spring" ||
    t === "spring clamp" ||
    t === "screw" ||
    t === "screw clamp" ||
    t === "top" ||
    t === "side" ||
    t === "stuck" ||
    t === "moving" ||
    t === "totally stuck"
  );
}

function parseYesNo(text: string): boolean | null {
  const t = onlyLetters(text);
  if (t === "yes" || t === "y" || t === "yeah" || t === "yep" || t === "sure" || t === "correct") return true;
  if (t === "no" || t === "n" || t === "nope" || t === "nah" || t === "notreally") return false;
  return null;
}

function parseChoice(text: string): "compatibility" | "install" | "symptom" | null {
  const t = norm(text);
  if (t.includes("compat")) return "compatibility";
  if (t.includes("install")) return "install";
  if (t.includes("symptom") || t.includes("issue") || t.includes("problem") || t.includes("trouble")) return "symptom";
  return null;
}

function parseClampType(text: string): "spring" | "screw" | null {
  const t = norm(text);
  if (t.includes("spring")) return "spring";
  if (t.includes("screw")) return "screw";
  return null;
}

function parseDrainSpeed(text: string): "standing" | "slow" | null {
  const t = norm(text);
  if (t.includes("standing") || t.includes("still water") || t.includes("full of water") || t === "standing water") return "standing";
  if (t.includes("slow") || t.includes("slowly") || t.includes("drain slowly") || t.includes("drains slowly")) return "slow";
  return null;
}

type PumpSound = "running" | "humming" | "silent" | "unknown";
function parsePumpSound(text: string): PumpSound {
  const t = norm(text);

  const yn = parseYesNo(text);
  if (yn === true) return "running";
  if (yn === false) return "silent";

  if (t.includes("hum") || t.includes("buzz") || t.includes("humming") || t.includes("buzzing")) return "humming";
  if (t.includes("silent") || t.includes("no sound") || t.includes("quiet") || t.includes("totally silent")) return "silent";
  if (t.includes("running") || t.includes("normal") || t.includes("i hear it") || t.includes("hear it")) return "running";

  return "unknown";
}

function parsePanelFastener(text: string): "screws" | "clips" | null {
  const t = norm(text);
  if (t.includes("screw")) return "screws";
  if (t.includes("clip")) return "clips";
  return null;
}

function parseLatchSide(text: string): "top" | "side" | null {
  const t = norm(text);
  if (t.includes("top")) return "top";
  if (t.includes("side")) return "side";
  return null;
}
type MovingOrStuck = "moving" | "stuck" | "unknown";
function parseMovingOrStuck(text: string): MovingOrStuck {
  const t = norm(text);
  if (t.includes("moving")) return "moving";
  if (t.includes("stuck")) return "stuck"; // covers "totally stuck"
  return "unknown";
}

//type DrainHoseSetup = "high_loop" | "air_gap" | "neither" | "sink_connection" | "unknown";
function parseDrainHoseSetup(text: string): DrainHoseSetup {
  const t = norm(text);
  if (t.includes("air gap") || t.includes("airgap")) return "air_gap";
  if (t.includes("high loop") || (t.includes("loop") && t.includes("high"))) return "high_loop";
  if (t.includes("sink") || t.includes("disposal") || t.includes("garbage disposal")) return "sink_connection";
  if (t.includes("neither") || t.includes("none")) return "neither";
  if (t === "no") return "unknown";
  return "unknown";
}

//type SinkConnectionType = "disposal" | "tailpiece" | "unknown";
function parseSinkConnectionType(text: string): SinkConnectionType {
  const t = norm(text);
  if (t.includes("disposal") || t.includes("garbage")) return "disposal";
  if (t.includes("tailpiece") || t.includes("tail piece") || t.includes("sink")) return "tailpiece";
  return "unknown";
}

/** -------------------- Handoff detection -------------------- */
function everRequestedHuman(history: ChatMessage[] | undefined): boolean {
  for (const m of lastNUser(history, 10)) {
    if (wantsHuman(m.content)) return true;
  }
  return false;
}

function handoffPending(history: ChatMessage[] | undefined): boolean {
  const a = lastAssistant(history);
  if (!a) return false;
  const t = a.content.toLowerCase();
  const asksEmail = t.includes("send your email") || t.includes("share your email") || t.includes("your email");
  const mentionsTicket = t.includes("ticket") || t.includes("human follow-up") || t.includes("human") || t.includes("support");
  return asksEmail && mentionsTicket;
}

/** -------------------- Install follow-up -------------------- */
type InstallStep = "panel" | "clamps" | "connector" | "unknown";

function detectInstallStepFollowup(history: ChatMessage[] | undefined, userMessage: string): InstallStep | null {
  const a = lastAssistant(history)?.content?.toLowerCase() ?? "";
  const u = (userMessage ?? "").toLowerCase();

  // if user clearly shifts intent, don't consume as install-step
  if (hasGlobalIntentKeyword(u) || extractPartNumberFromLinkOrText(userMessage) || extractModelNumber(userMessage) || wantsReturnRefundShipping(userMessage)) return null;

  const aAsked =
    a.includes("which step is blocking you") ||
    a.includes("which step are you on: panel, clamps, or connector") ||
    (a.includes("panel") && a.includes("clamps") && a.includes("connector"));

  if (!aAsked) return null;

  if (u.includes("panel") || u.includes("kickplate") || u.includes("access panel") || u.includes("toe kick")) return "panel";
  if (u.includes("clamp") || u.includes("clamps") || u.includes("hose clamp") || u.includes("pliers")) return "clamps";
  if (u.includes("connector") || u.includes("wire") || u.includes("harness") || u.includes("plug")) return "connector";

  return null;
}

function replyInstallStepHelp(step: InstallStep) {
  if (step === "panel") {
    return (
      "For the access panel: it’s usually a couple screws along the bottom edge. " +
      "If it won’t drop, check for hidden clips near the sides. " +
      "Do you see screws, or plastic clips?"
    );
  }
  if (step === "clamps") {
    return (
      "For hose clamps: pliers help — squeeze, slide the clamp back, then twist the hose gently to break the seal. " +
      "Avoid yanking straight (it can tear the hose). " +
      "Is it a spring clamp (two tabs) or a screw clamp?"
    );
  }
  if (step === "connector") {
    return (
      "For the connector: most have a small locking tab. Press the tab in while pulling straight out. " +
      "If it’s stuck, wiggle gently — don’t pull on the wires. " +
      "Do you see a latch on the top or side?"
    );
  }
  return "Which step are you on: panel, clamps, or connector?";
}

function replyPanelFastenerHelp(kind: "screws" | "clips") {
  if (kind === "screws") {
    return (
      "Got it — screws.\n" +
      "Tip: check the very bottom edge + corners (some are tucked under the toe-kick). If they’re Torx, you may need a T15/T20 bit.\n" +
      "After removing screws, the panel usually tilts out then drops down.\n\n" +
      "Do the screws come out but the panel still won’t drop?"
    );
  }
  return (
    "Got it — clips.\n" +
    "Tip: pull the panel slightly forward and then down. A plastic pry tool (or a taped flathead) helps avoid cracking.\n\n" +
    "Do you see clip tabs on the left/right edges, or along the top seam?"
  );
}

function replyConnectorLatchHelp(side: "top" | "side") {
  if (side === "top") {
    return (
      "Latch on TOP: press the top tab down/in firmly, then pull the connector straight off.\n" +
      "If it’s tight, push the connector *in* a hair first, then press tab, then pull.\n\n" +
      "Is it moving at all, or totally stuck?"
    );
  }
  return (
    "Latch on SIDE: pinch/press the side tab inward while pulling straight out.\n" +
    "Same trick: push in slightly first → press tab → pull.\n\n" +
    "Is it moving at all, or totally stuck?"
  );
}

/** -------------------- Reply helpers -------------------- */
function replyHome() {
  return (
    "Hi! I can help with refrigerator and dishwasher parts on PartSelect — part info, compatibility, installation, and troubleshooting.\n\n" +
    "Try:\n" +
    "• “Is PS11752778 compatible with my WDT780SAEM1 model?”\n" +
    "• “How can I install part number PS11752778?”"
  );
}

function replyAskForFullPart(shortToken?: string) {
  const hint = shortToken ? `\n\nI saw "${shortToken}" — part numbers usually look like PS + 5–10 digits.` : "";
  return `What’s the full PartSelect part number (starts with PS…)?${hint}`;
}

function compactInstallSteps(partNumber: string, modelNumber?: string) {
  const modelLine = modelNumber ? ` (model ${modelNumber})` : "";
  return (
    `Quick install outline for ${partNumber}${modelLine}:\n` +
    "1) Turn off power (and water if needed)\n" +
    "2) Remove the lower access panel\n" +
    "3) Take a photo of wires/hoses\n" +
    "4) Disconnect hose clamps + connector\n" +
    "5) Swap the part, reassemble, run a short test\n\n" +
    "Which step are you on: panel, clamps, or connector?"
  );
}

function compactInstallRepeatVariant(partNumber: string, modelNumber?: string, repeats: number = 1) {
  const modelLine = modelNumber ? ` (${modelNumber})` : "";
  if (repeats % 2 === 0) return `Looks like we’re still on the install for ${partNumber}${modelLine}.\nWant help with panel, clamps, or connector?`;
  return `No worries — continuing ${partNumber}${modelLine} install.\nWhich step is blocking you: panel, clamps, or connector?`;
}

function troubleshootDishwasher(modelNumber?: string, repeated: boolean) {
  const header = modelNumber ? `Dishwasher not draining (${modelNumber}) — quick checks:` : "Dishwasher not draining — quick checks:";
  const base =
    `${header}\n` +
    "- Clean the filter/sump area\n" +
    "- Check drain hose for kinks/clogs\n" +
    "- Make sure the disposal knockout plug is removed\n\n" +
    "When it tries to drain, do you hear the drain pump running? (yes/no)";
  if (!repeated) return base;
  return base + "\n\nIf you already tried those: share any error code, and whether the pump is silent, humming, or normal.";
}

function troubleshootDishwasherDrainPumpFollowup(hearsPump: boolean) {
  if (hearsPump) {
    return (
      "Got it — pump is running.\n" +
      "That usually points to a blockage or drain path issue:\n" +
      "- Check the sink/disposal connection (knockout plug)\n" +
      "- Inspect the drain hose loop for kinks / gunk\n" +
      "- If accessible, check the check-valve / drain outlet for debris\n\n" +
      "Is it leaving standing water, or does it drain slowly?"
    );
  }
  return (
    "OK — pump is NOT running.\n" +
    "That’s more like power/control or a failed pump:\n" +
    "- Do you hear any hum/click when it tries to drain?\n" +
    "- Any error code showing?\n" +
    "- Confirm the door latch is fully closing\n\n" +
    "If you share the model, I can suggest the best next check."
  );
}

function troubleshootDishwasherDrainSpeedFollowup(kind: "standing" | "slow") {
  if (kind === "slow") {
    return (
      "Drain is slow — usually partial blockage.\n" +
      "- Inspect drain hose for kinks + buildup\n" +
      "- Check the sink/disposal connection for gunk\n" +
      "- Clean filter/sump again + look for debris at the drain outlet\n\n" +
      "Quick check: does your drain hose have a high loop / air gap under the sink?"
    );
  }
  return (
    "Standing water — closer to a full blockage or a stuck check-valve.\n" +
    "- Verify disposal knockout plug is removed\n" +
    "- Check drain hose for a hard clog\n" +
    "- If accessible, check-valve at the pump outlet may be stuck\n\n" +
    "When it tries to drain, is it humming/buzzing, or totally silent?"
  );
}

type DrainHoseSetup = "high_loop" | "air_gap" | "neither" | "sink_connection" | "unknown";
type SinkConnectionType = "disposal" | "tailpiece" | "unknown";

function troubleshootDishwasherHoseSetupFollowup(kind: DrainHoseSetup) {
  if (kind === "high_loop") {
    return (
      "Nice — high loop is good.\n" +
      "Next most common culprit is the sink/disposal connection:\n" +
      "- If connected to a garbage disposal, confirm the knockout plug was removed\n" +
      "- Pull the drain hose off and check for gunk at the inlet\n" +
      "- Check the hose itself for a partial clog (food/grease)\n\n" +
      "Are you connected to a garbage disposal, or directly to the sink tailpiece?"
    );
  }
  if (kind === "air_gap") {
    return (
      "Air gap setup — good.\n" +
      "If draining is slow, the air gap or hose after it may be partially clogged.\n" +
      "Quick check:\n" +
      "- Pop the air-gap cap and look for debris\n" +
      "- Inspect the hose from air gap → disposal/tailpiece for buildup\n\n" +
      "Do you see any gunk in the air gap, or is it clean?"
    );
  }
  if (kind === "sink_connection") {
    return (
      "Got it — let’s focus on the sink/disposal side.\n" +
      "Common issue: disposal knockout plug still in place, or sludge clog at the inlet.\n\n" +
      "Are you draining into a garbage disposal, or directly to the sink tailpiece?"
    );
  }
  if (kind === "neither") {
    return (
      "If there’s no high loop / air gap, slow drain can happen from backflow.\n" +
      "Easy fix: add a high loop (strap the hose up under the counter as high as possible).\n\n" +
      "After you add the loop, does draining improve? (yes/no)"
    );
  }
  return "Do you have a high loop, an air gap, or neither? (And is it connected to the sink tailpiece or garbage disposal?)";
}

function replyDidItFixClose(yes: boolean) {
  if (yes) {
    return (
      "Awesome — sounds like it’s draining normally now. ✅\n\n" +
      "Anything else you want to do?\n" +
      "- check compatibility (PS… + model)\n" +
      "- installation steps\n" +
      "- another symptom"
    );
  }
  return (
    "Got it — still not draining right.\n" +
    "At this point the usual next suspects are:\n" +
    "- blockage at pump inlet / sump\n" +
    "- stuck check valve\n" +
    "- weak/failing drain pump\n\n" +
    "Do you want to keep troubleshooting here, or do you want a human follow-up? (type “human”)"
  );
}

function troubleshootDishwasherSinkConnectionFollowup(kind: SinkConnectionType) {
  if (kind === "disposal") {
    return (
      "Connected to a garbage disposal — biggest gotcha is the knockout plug.\n" +
      "Quick checks:\n" +
      "- Remove the drain hose at the disposal inlet and look inside for the knockout plug\n" +
      "- Clean sludge at the disposal inlet nipple\n" +
      "- Run disposal briefly + flush hot water\n\n" +
      "If you remove the hose, do you see strong water flow from the dishwasher when it tries to drain (yes/no)?"
    );
  }
  if (kind === "tailpiece") {
    return (
      "Connected to the sink tailpiece.\n" +
      "Quick checks:\n" +
      "- Check the tailpiece branch nipple for gunk (common)\n" +
      "- Ensure the hose clamp isn’t pinching the hose\n" +
      "- Confirm the hose has no sagging low-spot holding water\n\n" +
      "If you disconnect the hose at the tailpiece, is it clogged with gunk (yes/no)?"
    );
  }
  return "Are you connected to a garbage disposal, or directly to the sink tailpiece?";
}

function replyDisposalFlowYesNo(yes: boolean) {
  if (yes) {
    return (
      "Good — that means the dishwasher *is* pumping strongly.\n" +
      "So the slowdown is almost certainly AFTER the dishwasher:\n" +
      "- disposal inlet nipple gunk\n" +
      "- OR the disposal knockout plug still inside\n\n" +
      "When you look into the disposal inlet (where the hose connects), is the knockout plug already removed? (yes/no)"
    );
  }
  return (
    "If there’s weak/no flow at the hose, that points upstream:\n" +
    "- drain hose clogged/kinked\n" +
    "- sump/pump inlet blocked\n" +
    "- check valve stuck\n\n" +
    "Quick check: if you remove the hose and try draining into a bucket, do you get *any* water at all? (yes/no)"
  );
}

function replyDisposalKnockoutYesNo(yes: boolean) {
  if (yes) {
    return (
      "Nice — knockout is removed.\n" +
      "Next: clean the disposal inlet nipple + the first few inches of hose (it often cakes up with sludge).\n\n" +
      "After cleaning, does it drain normally now? (yes/no)"
    );
  }
  return (
    "That’s likely the whole issue.\n" +
    "Remove the knockout plug (usually punch it through with a screwdriver, then fish it out).\n" +
    "Reconnect hose, run disposal briefly, then test drain.\n\n" +
    "After removing the knockout plug, does it drain normally now? (yes/no)"
  );
}

function replyTailpieceGunkYesNo(yes: boolean) {
  if (yes) {
    return (
      "Yep — that’ll do it.\n" +
      "Clean the tailpiece nipple + hose end (bottle brush works), reconnect, and test.\n\n" +
      "After cleaning, does it drain normally now? (yes/no)"
    );
  }
  return (
    "If there’s no gunk there, next suspects are:\n" +
    "- partial clog somewhere in the hose\n" +
    "- blockage at pump/check valve\n\n" +
    "After re-connecting everything, does it drain normally now? (yes/no)"
  );
}

/** -------------------- Order support replies (demo) -------------------- */
function replyOrderIntake(ask: "order_id" | "zip" | "both") {
  if (ask === "both") return "To help with order status/returns (demo), send your order number and ZIP code.\nExample: ORDER #A1B2C3 19104";
  if (ask === "order_id") return "Send your order number (demo).\nExample: ORDER #A1B2C3";
  return "Send the ZIP code on the order (demo).\nExample: 19104";
}

function replyOrderStub(orderId?: string, zip?: string) {
  const a = orderId ? `order=${orderId}` : "order=n/a";
  const z = zip ? `zip=${zip}` : "zip=n/a";
  return (
    `Got it (${a}, ${z}). In this demo I can’t access real order systems, but I can still help you choose the right path:\n` +
    "- shipping delay / tracking\n" +
    "- return / refund policy steps\n" +
    "- wrong part ordered (compatibility check)\n\n" +
    "Which one is it: shipping, return/refund, or wrong part?"
  );
}

/** -------------------- Demo ticket tool -------------------- */
function createSupportTicketDemo(args: { email: string; summary: string; modelNumber?: string; partNumber?: string }) {
  const id = `TCK-${Math.floor(100000 + Math.random() * 900000)}`;
  return {
    ticketId: id,
    sources: [{ label: "Support handoff (demo)" }],
    data: { ...args, ticketId: id },
  };
}

/** -------------------- Context leakage guard -------------------- */
function shouldClearAwaiting(awaiting: Awaiting, currentIntent: Intent, currentAppliance: Appliance, message: string): boolean {
  if (!awaiting) return false;

  // If user types explicit new intent keyword or strong entities, clear
  if (hasGlobalIntentKeyword(message)) return true;
  if (extractPartNumberFromLinkOrText(message) || extractModelNumber(message) || extractOrderId(message) || extractZip(message)) return true;

  // If user is in troubleshoot but awaiting install detail, clear
  if (
    currentIntent === "troubleshooting" &&
    (awaiting.kind === "install_step" || awaiting.kind === "clamp_type" || awaiting.kind === "panel_fastener" || awaiting.kind === "connector_latch_side")
  ) {
    return true;
  }

  // If appliance flips to refrigerator and we are in dishwasher troubleshooting micro-flow, clear
  if (currentAppliance === "refrigerator" && isAwaitingTroubleshoot(awaiting)) return true;

  return false;
}

/** -------------------- Main -------------------- */
export async function handleChatTurn(req: ChatRequest): Promise<ChatResponse> {
  const message = req.message ?? "";
  const history = req.history ?? [];

  let awaiting = inferDialogState(history);

  // appliance pinning
  const appliance = inferPinnedAppliance(message, history);

  const { partNumber, modelNumber, hasIncompletePart, shortPart } = resolveEntities(message, history, appliance);

  const repeats = countUserRepeatsExcludingCurrent(history, message);
  const isRepeated = repeats >= 1;

  let intent0: Intent = inferIntent(message);

  if (shouldClearAwaiting(awaiting, intent0, appliance, message)) awaiting = null;

  /**
   * Intent stickiness:
   * - If awaiting install micro-step: keep short replies in install lane unless clear shift.
   */
  if (awaiting && isAwaitingInstall(awaiting) && !isClearIntentShift(message)) {
    if (isInstallQuickReply(message) || intent0 === "unknown" || looksLikeAck(message)) intent0 = "installation_help";
  }

  /**
   * Troubleshoot stickiness
   */
  if (awaiting && isAwaitingTroubleshoot(awaiting) && !isClearIntentShift(message)) {
    if (intent0 === "unknown" || looksLikeAck(message) || parseYesNo(message) !== null) intent0 = "troubleshooting";
  }

  /**
   * Order stickiness
   */
  if (awaiting && isAwaitingOrder(awaiting) && !isClearIntentShift(message)) {
    if (intent0 === "unknown" || looksLikeAck(message)) intent0 = "order_support";
  }

  /**
   * If user provides both PS + model but didn't say "compatible",
   * it is usually compatibility intent.
   */
  if (intent0 === "unknown" && !!extractPartNumberFromLinkOrText(message) && !!extractModelNumber(message)) {
    intent0 = "compatibility_check";
  }

  const metaBase: ChatResponse["meta"] = {
    inDomain: true,
    intent: intent0,
    extracted: { partNumber, modelNumber, appliance },
    toolsUsed: [],
    sources: [],
  };

  /** Domain filter */
  const yn = parseYesNo(message);
  const allowed =
    awaiting !== null ||
    looksLikeSmallTalk(message) ||
    looksLikeAck(message) ||
    wantsHuman(message) ||
    wantsReturnRefundShipping(message) ||
    looksLikeUrl(message) ||
    yn !== null ||
    isInstallQuickReply(message) ||
    ["humming", "buzzing", "silent", "stuck", "moving"].includes(norm(message)) ||
    message.toLowerCase().includes("dishwasher") ||
    message.toLowerCase().includes("refrigerator") ||
    message.toLowerCase().includes("fridge") ||
    message.toLowerCase().includes("freezer") ||
    message.toLowerCase().includes("ice maker") ||
    message.toLowerCase().includes("install") ||
    message.toLowerCase().includes("compatible") ||
    message.toLowerCase().includes("troubleshoot") ||
    message.toLowerCase().includes("drain") ||
    message.toLowerCase().includes("pump") ||
    message.toLowerCase().includes("loop") ||
    message.toLowerCase().includes("air gap") ||
    message.toLowerCase().includes("sink") ||
    message.toLowerCase().includes("tailpiece") ||
    message.toLowerCase().includes("disposal") ||
    message.toLowerCase().includes("knockout") ||
    message.toLowerCase().includes("ps") ||
    !!partNumber ||
    !!modelNumber ||
    !!extractOrderId(message) ||
    !!extractZip(message);

  if (!allowed) {
    return {
      reply:
        "I’m focused on PartSelect refrigerator and dishwasher parts (compatibility, install, troubleshooting, basic order support).\n" +
        "If you share a PS part number or model number, I can help from there.",
      meta: { ...metaBase, inDomain: false, intent: "unknown" },
      cards: [],
    };
  }

  /** Incomplete part token */
  if (hasIncompletePart) {
    return { reply: replyAskForFullPart(shortPart), meta: metaBase, cards: [] };
  }

  /** Highest priority: human handoff by email */
  const email = extractEmail(message);
  const humanAsked = everRequestedHuman(history);
  const pendingRaw = handoffPending(history);
  const pending = pendingRaw && !isClearIntentShift(message) && !extractEmail(message);

  if (email && (humanAsked || pending || wantsHuman(message))) {
    const summary =
      `User requested human support. ` +
      `appliance=${appliance}; model=${modelNumber ?? "n/a"}; part=${partNumber ?? "n/a"}; ` +
      `last="${message}"`;

    const r = createSupportTicketDemo({ email, summary, modelNumber, partNumber });

    return {
      reply:
        `Got it — I opened a support ticket for human follow-up (demo).\n` +
        `Ticket: ${r.ticketId}\n\n` +
        `While you wait, tell me what you want to solve (compatibility, install, or the symptom) and I can keep helping.`,
      meta: { ...metaBase, intent: "order_support", toolsUsed: ["toolCreateSupportTicketDemo"], sources: r.sources ?? [] },
      cards: [],
    };
  }

  /** If user asks human (without email) */
  if (wantsHuman(message) || pending) {
    return {
      reply:
        "Sure — I can set up a human follow-up (demo ticket).\n" +
        "Just send your email in the next message.\n" +
        'Example: "name@email.com WDT780SAEM1 PS11752778"',
      meta: { ...metaBase, intent: "order_support" },
      cards: [],
    };
  }

  /** Ack handling (don’t hijack awaiting flow) */
  if (looksLikeAck(message)) {
    if (awaiting?.kind === "order_info") return { reply: replyOrderIntake(awaiting.ask), meta: { ...metaBase, intent: "order_support" }, cards: [] };

    if (awaiting?.kind === "pump_sound")
      return { reply: "When it tries to drain, is the pump running, humming/buzzing, or totally silent?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "dishwasher_drain_speed") return { reply: "Which one is it: standing water, or drains slowly?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "drain_hose_setup")
      return { reply: "Do you have a high loop, an air gap, or neither? (And is it connected to the sink tailpiece or garbage disposal?)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "sink_connection_type") return { reply: "Are you connected to a garbage disposal, or directly to the sink tailpiece?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "disposal_flow_yesno") return { reply: "Do you see strong water flow from the dishwasher when it tries to drain (yes/no)?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "disposal_knockout_yesno") return { reply: "Is the disposal knockout plug already removed? (yes/no)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "tailpiece_gunk_yesno") return { reply: "If you disconnect the hose at the tailpiece, is it clogged with gunk (yes/no)?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (awaiting?.kind === "did_it_fix_yesno") return { reply: "After that change, does it drain normally now? (yes/no)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };

    if (awaiting?.kind === "install_step") return { reply: "Which step are you on: panel, clamps, or connector?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    if (awaiting?.kind === "clamp_type") return { reply: "Is it a spring clamp (two tabs) or a screw clamp?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    if (awaiting?.kind === "panel_fastener") return { reply: "Do you see screws, or plastic clips?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    if (awaiting?.kind === "connector_latch_side") return { reply: "Is the latch on the top, or on the side?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    if (awaiting?.kind === "panel_still_wont_drop_yesno")
  return { reply: "Do the screws come out but the panel still won’t drop? (yes/no)", meta: { ...metaBase, intent: "installation_help" }, cards: [] };

if (awaiting?.kind === "connector_moving_or_stuck")
  return { reply: "Is it moving at all, or totally stuck?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };

    return { reply: "👍 Okay. Want help with compatibility, installation, troubleshooting, order support, or a PS part number?", meta: { ...metaBase, intent: "unknown" }, cards: [] };
  }

  /** Small talk (✅ do NOT reset when awaiting something) */
  if (looksLikeSmallTalk(message) && awaiting === null) {
    return { reply: replyHome(), meta: { ...metaBase, intent: "unknown", inDomain: true }, cards: [] };
  }

  /** -------------------- Follow-up pre-routing (consume awaiting first) -------------------- */

  // Order awaiting
  if (awaiting?.kind === "order_info") {
    const oid = extractOrderId(message);
    const zip = extractZip(message);

    if (awaiting.ask === "order_id" && !oid && !isClearIntentShift(message)) return { reply: replyOrderIntake("order_id"), meta: { ...metaBase, intent: "order_support" }, cards: [] };
    if (awaiting.ask === "zip" && !zip && !isClearIntentShift(message)) return { reply: replyOrderIntake("zip"), meta: { ...metaBase, intent: "order_support" }, cards: [] };
    if (awaiting.ask === "both" && (!oid || !zip) && !isClearIntentShift(message)) return { reply: replyOrderIntake("both"), meta: { ...metaBase, intent: "order_support" }, cards: [] };

    return { reply: replyOrderStub(oid, zip), meta: { ...metaBase, intent: "order_support" }, cards: [] };
  }

  if (awaiting?.kind === "dishwasher_drain_speed") {
    const k = parseDrainSpeed(message);
    if (k !== null) return { reply: troubleshootDishwasherDrainSpeedFollowup(k), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    if (!isClearIntentShift(message)) return { reply: "Which one is it: standing water, or drains slowly?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
  }
    if (awaiting?.kind === "fridge_freezer_warming_yesno") {
    if (!isClearIntentShift(message)) {
      const yn = parseYesNo(message);
      if (yn === null) {
        return { reply: "Is the freezer also warming up? (yes/no)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      }

      if (yn === true) {
        return {
          reply:
            "If BOTH fridge + freezer are warming up, it’s usually a cooling-system issue:\n" +
            "- Check if the condenser fan is running\n" +
            "- Clean condenser coils\n" +
            "- Make sure the compressor is running (low hum/vibration)\n" +
            "- Check for heavy frost on the freezer back panel (defrost issue)\n\n" +
            "Do you hear the condenser fan near the bottom/back running? (yes/no)",
          meta: { ...metaBase, intent: "troubleshooting" },
          cards: [],
        };
      }

      return {
        reply:
          "If freezer is OK but fridge is warm, it’s often an airflow issue:\n" +
          "- Vents blocked by food\n" +
          "- Damper stuck closed\n" +
          "- Evaporator fan not running\n\n" +
          "Do you feel airflow from the fridge vents, and do you hear a small fan inside the freezer? (yes/no)",
        meta: { ...metaBase, intent: "troubleshooting" },
        cards: [],
      };
    }
  }

  if (awaiting?.kind === "pump_sound") {
    if (!isClearIntentShift(message)) {
      let ps = parsePumpSound(message);
      let usedGroq = false;

      if (ps === "unknown") {
        const llm = await groqParsePumpSound(message);
        if (llm !== "unknown") {
          ps = llm;
          usedGroq = true;
        }
      }

      const toolsUsed = usedGroq ? [...metaBase.toolsUsed, "groqParsePumpSound"] : metaBase.toolsUsed;

      if (ps === "humming") {
        return {
          reply:
            "Humming usually means the pump is trying to run but water isn’t moving.\n" +
            "Common causes:\n" +
            "- blockage at filter/sump or pump inlet\n" +
            "- stuck check valve\n" +
            "- clogged drain hose / disposal connection\n\n" +
            "Is there standing water, or does it drain slowly?",
          meta: { ...metaBase, intent: "troubleshooting", toolsUsed },
          cards: [],
        };
      }
      if (ps === "running")
        return {
          reply: troubleshootDishwasherDrainPumpFollowup(true),
          meta: { ...metaBase, intent: "troubleshooting", toolsUsed },
          cards: [],
        };
      if (ps === "silent")
        return {
          reply: troubleshootDishwasherDrainPumpFollowup(false),
          meta: { ...metaBase, intent: "troubleshooting", toolsUsed },
          cards: [],
        };

      return {
        reply: "When it tries to drain, is the pump running, humming/buzzing, or totally silent?",
        meta: { ...metaBase, intent: "troubleshooting", toolsUsed },
        cards: [],
      };
    }
  }

  if (awaiting?.kind === "drain_hose_setup") {
    if (!isClearIntentShift(message)) {
      const hs = parseDrainHoseSetup(message);
      if (hs === "unknown") {
        return {
          reply: "Do you have a high loop, an air gap, or neither? (And is it connected to the sink tailpiece or garbage disposal?)",
          meta: { ...metaBase, intent: "troubleshooting" },
          cards: [],
        };
      }
      return { reply: troubleshootDishwasherHoseSetupFollowup(hs), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "sink_connection_type") {
    if (!isClearIntentShift(message)) {
      const k = parseSinkConnectionType(message);
      if (k === "unknown") return { reply: "Are you connected to a garbage disposal, or directly to the sink tailpiece?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      return { reply: troubleshootDishwasherSinkConnectionFollowup(k), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "disposal_flow_yesno") {
    if (!isClearIntentShift(message)) {
      const yn2 = parseYesNo(message);
      if (yn2 === null) return { reply: "Do you see strong water flow from the dishwasher when it tries to drain (yes/no)?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      return { reply: replyDisposalFlowYesNo(yn2), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "disposal_knockout_yesno") {
    if (!isClearIntentShift(message)) {
      const yn2 = parseYesNo(message);
      if (yn2 === null) return { reply: "Is the disposal knockout plug already removed? (yes/no)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      return { reply: replyDisposalKnockoutYesNo(yn2), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "tailpiece_gunk_yesno") {
    if (!isClearIntentShift(message)) {
      const yn2 = parseYesNo(message);
      if (yn2 === null) return { reply: "If you disconnect the hose at the tailpiece, is it clogged with gunk (yes/no)?", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      return { reply: replyTailpieceGunkYesNo(yn2), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "did_it_fix_yesno") {
    if (!isClearIntentShift(message)) {
      const yn2 = parseYesNo(message);
      if (yn2 === null) return { reply: "After that change, does it drain normally now? (yes/no)", meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
      return { reply: replyDidItFixClose(yn2), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }
  }

  if (awaiting?.kind === "choice") {
    const choice = parseChoice(message);
    if (!choice) return { reply: "Which one do you want to work on: compatibility, install, or the symptom?", meta: { ...metaBase, intent: "unknown" }, cards: [] };
    intent0 = choice === "compatibility" ? "compatibility_check" : choice === "install" ? "installation_help" : "troubleshooting";
  }

  if (awaiting?.kind === "panel_fastener") {
    if (!isClearIntentShift(message)) {
      const k = parsePanelFastener(message);
      if (!k) return { reply: "Do you see screws, or plastic clips?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
      return { reply: replyPanelFastenerHelp(k), meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    }
  }

  if (awaiting?.kind === "clamp_type") {
    if (!isClearIntentShift(message)) {
      const ct = parseClampType(message);
      if (!ct) return { reply: "Is it a spring clamp (two tabs) or a screw clamp?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };

      if (ct === "spring") {
        return {
          reply:
            "Spring clamp: grab the two tabs with pliers, squeeze to open, slide it back on the hose, then twist the hose gently to break the seal.\n" +
            "If it’s stuck, a tiny flathead can help gently lift the hose edge (don’t puncture it).",
          meta: { ...metaBase, intent: "installation_help" },
          cards: [],
        };
      }
      return {
        reply:
          "Screw clamp: loosen the screw a few turns (don’t remove it), slide the clamp back, then twist the hose to break the seal.\n" +
          "If the hose won’t budge, wiggle + twist instead of pulling straight.",
        meta: { ...metaBase, intent: "installation_help" },
        cards: [],
      };
    }
  }
    if (awaiting?.kind === "panel_still_wont_drop_yesno") {
    if (!isClearIntentShift(message)) {
      const yn2 = parseYesNo(message);
      if (yn2 === null) {
        return { reply: "Do the screws come out but the panel still won’t drop? (yes/no)", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
      }

      if (yn2 === true) {
        return {
          reply:
            "Got it — screws come out but panel won’t drop.\n" +
            "Most common causes:\n" +
            "- A hidden clip/retainer near the sides\n" +
            "- The toe-kick overlaps the access panel (two-piece panel)\n" +
            "- Panel needs to tilt out first, then slide down\n\n" +
            "Try this: pull the *bottom edge* slightly toward you to unhook, then slide the panel down.\n" +
            "Do you see any side clips you can press in? (yes/no)",
          meta: { ...metaBase, intent: "installation_help" },
          cards: [],
        };
      }

      // yn2 === false
      return {
        reply:
          "If screws don’t come out, check:\n" +
          "- Are they Torx (T15/T20)?\n" +
          "- Any screws tucked under the very bottom lip/corners?\n" +
          "- Are you turning the right direction (counter-clockwise)?\n\n" +
          "Are the screws Torx? (yes/no)",
        meta: { ...metaBase, intent: "installation_help" },
        cards: [],
      };
    }
  }
    if (awaiting?.kind === "connector_moving_or_stuck") {
    if (!isClearIntentShift(message)) {
      const ms = parseMovingOrStuck(message);
      if (ms === "unknown") {
        return { reply: "Is it moving at all, or totally stuck?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
      }

      if (ms === "moving") {
        return {
          reply:
            "If it’s moving, keep steady pressure while holding the latch fully depressed.\n" +
            "Tip: rock it gently side-to-side (tiny motions) while pulling straight back — don’t yank the wires.\n\n" +
            "Once it’s off, do you see corrosion/dirt on the pins? (yes/no)",
          meta: { ...metaBase, intent: "installation_help" },
          cards: [],
        };
      }

      // stuck
      return {
        reply:
          "Totally stuck usually means the latch isn’t fully released or there’s a secondary lock.\n" +
          "Try:\n" +
          "1) Push the connector *in* slightly first (relieves tension)\n" +
          "2) Press/hold the latch HARD\n" +
          "3) Pull straight out while wiggling\n" +
          "4) If safe, use a small flathead to press the latch tab (don’t pry the plastic housing)\n\n" +
          "Do you have enough access to press the latch firmly, or is it blocked by the frame? (blocked/accessible)",
        meta: { ...metaBase, intent: "installation_help" },
        cards: [],
      };
    }
  }

  if (awaiting?.kind === "connector_latch_side") {
    if (!isClearIntentShift(message)) {
      const side = parseLatchSide(message);
      if (side) return { reply: replyConnectorLatchHelp(side), meta: { ...metaBase, intent: "installation_help" }, cards: [] };

      const yn2 = parseYesNo(message);
      if (yn2 === true) return { reply: "Got it — where is the latch: top, or side?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
      if (yn2 === false) {
        return {
          reply:
            "If you don’t see a latch, some connectors use a small hidden tab underneath.\n" +
            "Try feeling for a tab and press it while pulling straight out (don’t pull the wires).\n\n" +
            "Do you see any small tab on the underside?",
          meta: { ...metaBase, intent: "installation_help" },
          cards: [],
        };
      }

      return { reply: "Is the latch on the top, or on the side?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    }
  }

  if (awaiting?.kind === "install_step") {
    if (!isClearIntentShift(message)) {
      const step = detectInstallStepFollowup(history, message);
      if (step) return { reply: replyInstallStepHelp(step), meta: { ...metaBase, intent: "installation_help" }, cards: [] };
      return { reply: "Which step are you on: panel, clamps, or connector?", meta: { ...metaBase, intent: "installation_help" }, cards: [] };
    }
  }

  /** -------------------- Order support -------------------- */
  if (intent0 === "order_support") {
    const orderId = extractOrderId(message);
    const zip = extractZip(message);

    if (!orderId && !zip && wantsReturnRefundShipping(message)) {
      return { reply: replyOrderIntake("both"), meta: { ...metaBase, intent: "order_support" }, cards: [] };
    }

    if (orderId || zip) {
      return { reply: replyOrderStub(orderId, zip), meta: { ...metaBase, intent: "order_support" }, cards: [] };
    }

    return {
      reply:
        "I can help with basic order questions in this demo.\n" +
        "If you want a human follow-up, say “human” and send your email — I’ll open a demo ticket.\n" +
        "If it’s about shipping/return, include order number + ZIP.",
      meta: metaBase,
      cards: [],
    };
  }

  /** -------------------- Compatibility -------------------- */
  if (intent0 === "compatibility_check") {
    if (!partNumber || !modelNumber) {
      if (!partNumber && !modelNumber)
        return { reply: "Send the part number (PS…) and your model number, and I’ll check compatibility.", meta: { ...metaBase, intent: "compatibility_check" }, cards: [] };
      if (!partNumber) return { reply: "What’s the part number (PS… or PartSelect link)?", meta: { ...metaBase, intent: "compatibility_check" }, cards: [] };
      return { reply: "What’s your model number?", meta: { ...metaBase, intent: "compatibility_check" }, cards: [] };
    }

    const r = toolCheckCompatibility(partNumber, modelNumber);
    const ok = (r as any).compatible;

    const reply =
      ok === true
        ? `Yes — ${partNumber} looks compatible with ${modelNumber}.`
        : ok === false
        ? `No — ${partNumber} doesn’t look compatible with ${modelNumber} in this demo catalog.`
        : `I can’t confirm compatibility for ${partNumber} with ${modelNumber} from the current demo index.`;

    return {
      reply: reply + "\nWant install steps, or are you troubleshooting a symptom?",
      meta: { ...metaBase, intent: "compatibility_check", toolsUsed: ["toolCheckCompatibility"], sources: (r as any).sources ?? [] },
      cards: [],
    };
  }

  /** -------------------- Installation -------------------- */
  if (intent0 === "installation_help") {
    if (!partNumber) return { reply: "What’s the full PartSelect part number (starts with PS…) or paste the PartSelect link?", meta: metaBase, cards: [] };

    const gs = toolSearchGuides({ query: message, appliance, mode: "install", topK: 2 });
    const guides = (gs as any).guides ?? [];
    const snippet = String(guides?.[0]?.snippet ?? "").trim();

    const looksUseless =
      !snippet ||
      snippet.toLowerCase() === "see guide for details." ||
      snippet.toLowerCase() === "steps available in guide." ||
      snippet.length < 12;

    if (looksUseless) {
      const reply = isRepeated ? compactInstallRepeatVariant(partNumber, modelNumber, repeats) : compactInstallSteps(partNumber, modelNumber);
      return { reply, meta: { ...metaBase, intent: "installation_help", toolsUsed: ["toolSearchGuides"], sources: (gs as any).sources ?? [] }, cards: [] };
    }

    const brief =
      `For ${partNumber}${modelNumber ? ` (${modelNumber})` : ""}, a key step is usually:\n` +
      `${snippet.replace(/\s+/g, " ").slice(0, 220)}${snippet.length > 220 ? "…" : ""}\n\n` +
      "Which step are you on: panel, clamps, or connector?";

    return { reply: brief, meta: { ...metaBase, intent: "installation_help", toolsUsed: ["toolSearchGuides"], sources: (gs as any).sources ?? [] }, cards: [] };
  }

  /** -------------------- Troubleshooting -------------------- */
  if (intent0 === "troubleshooting") {
    if (appliance === "dishwasher") {
      return { reply: troubleshootDishwasher(modelNumber, isRepeated), meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
    }

    const t = message.toLowerCase();
    const topicIce = t.includes("ice maker") || t.includes("icemaster") || t.includes("ice maker not working");

    const reply =
      topicIce
        ? "Ice maker not working — quick checks:\n- Water valve open and line not kinked\n- Freezer is cold enough (around 0°F)\n- Fill tube not frozen; replace filter if overdue\n\nIf you have it, what’s the fridge model number?"
        : "Fridge not cooling well — quick checks:\n- Vents not blocked by food\n- Clean condenser coils\n- Check whether the condenser fan is running\n\nIs the freezer also warming up?";

    return { reply, meta: { ...metaBase, intent: "troubleshooting" }, cards: [] };
  }

  /** -------------------- Part lookup (+ alternatives) -------------------- */
  if (intent0 === "part_lookup") {
    // allow lookup ONLY when PS... is typed THIS TURN
    const explicitPart = extractPartNumberFromLinkOrText(message);

    if (!explicitPart) {
      return { reply: "If you want to look up a part, paste the full PS part number (PS + 5–10 digits) or the PartSelect link.", meta: metaBase, cards: [] };
    }

    const r = toolLookupPart(explicitPart);
    const p = (r as any).part;

    if (!p) {
      return {
        reply: `I can’t find ${explicitPart} in the demo catalog. If you paste the PartSelect link, I can still help with install/troubleshooting.`,
        meta: { ...metaBase, intent: "part_lookup", toolsUsed: ["toolLookupPart"], sources: (r as any).sources ?? [] },
        cards: [],
      };
    }

    if (wantsAlternatives(message)) {
      return {
        reply:
          (modelNumber ? `For ${modelNumber}, ` : "") +
          "this demo doesn’t have a real cross-reference “alternatives” catalog.\n\n" +
          "What I can do instead:\n" +
          "- help you find same-category parts that list your model\n" +
          "- tell you what specs to match (connector, mounting, hose size)\n" +
          "- talk through OEM vs aftermarket trade-offs",
        meta: { ...metaBase, intent: "part_lookup", toolsUsed: ["toolLookupPart"], sources: (r as any).sources ?? [] },
        cards: [{ type: "part", partNumber: p.partNumber, name: p.name, price: p.price, imageUrl: p.imageUrl, compatibleModels: p.compatibleModels }],
      };
    }

    const followup =
      `Found it: ${p.partNumber} — ${p.name}.\n` +
      (modelNumber ? `Want me to check it against your model (${modelNumber})?` : "If you share your model number, I can check compatibility.");

    return {
      reply: followup,
      meta: { ...metaBase, intent: "part_lookup", toolsUsed: ["toolLookupPart"], sources: (r as any).sources ?? [] },
      cards: [{ type: "part", partNumber: p.partNumber, name: p.name, price: p.price, imageUrl: p.imageUrl, compatibleModels: p.compatibleModels }],
    };
  }

  /** Unknown but in-domain */
  return { reply: replyHome(), meta: metaBase, cards: [] };
}
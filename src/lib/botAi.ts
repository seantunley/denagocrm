import { recordAiUsage } from "./systemHealth";
import { getSetting } from "./settings";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { formatZAR } from "./format";

export type BotMsg = { role: "user" | "assistant"; content: string };
export type BotFaq = { id: string; question: string; answer: string; handoff?: boolean };
export type BotChoiceOption = { id: string; label: string; description?: string };

export async function getBotFaqs(): Promise<BotFaq[]> {
  const raw = await getSetting("BOT_FAQS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function isBotAiEnabled(): Promise<boolean> {
  return (
    (await getSetting("BOT_AI_ENABLED")) === "true" &&
    Boolean(await getSetting("ANTHROPIC_API_KEY"))
  );
}

function sanitize(msgs: BotMsg[]): BotMsg[] {
  const out: BotMsg[] = [];
  for (const m of msgs) {
    const content = m.content.trim();
    if (!content) continue;
    if (out.length === 0 && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + content;
    else out.push({ role: m.role, content });
  }
  return out;
}

function personalize(text: string, name?: string | null) {
  const first = name?.split(" ")[0] ?? "there";
  return text.replace(/\{\{\s*(first_name|name)\s*\}\}/g, first);
}

function parseFirstJsonObject(text: string): Record<string, unknown> {
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

/**
 * Semantic menu routing is deliberately constrained: the model may select ONE
 * id from the graph's existing options, or null. It cannot invent a destination,
 * emit a reply, or invoke a CRM action. Only high-confidence selections are used.
 */
export async function routeBotChoice(input: {
  prompt: string;
  text: string;
  options: BotChoiceOption[];
}): Promise<string | null> {
  if (!(await isBotAiEnabled())) return null;
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey || !input.text.trim() || input.options.length < 2) return null;

  const optionList = input.options
    .map((option) => `[${option.id}] ${option.label}${option.description ? ` — ${option.description}` : ""}`)
    .join("\n");
  const system = `You are a strict menu router. Map the customer's free-text reply to ONE of the supplied menu options only when their intent clearly matches it.

MENU PROMPT:
${input.prompt}

ALLOWED OPTIONS:
${optionList}

Return JSON only:
{"optionId":"<one supplied id or null>","confidence":"high|medium|low"}

Rules:
- Never invent an id.
- Use null when the customer asks something outside the menu, mentions multiple conflicting choices, or is ambiguous.
- Use confidence=high only when a normal human would clearly choose that menu item.
- Do not answer the customer and do not add any other fields.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 80,
        system,
        messages: [{ role: "user", content: input.text.trim() }],
      }),
    });
    if (!res.ok) {
      await logError("bot-choice-router", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const parsed = parseFirstJsonObject(String(json.content?.[0]?.text ?? "{}"));
    if (parsed.confidence !== "high" || typeof parsed.optionId !== "string") return null;
    return input.options.some((option) => option.id === parsed.optionId) ? parsed.optionId : null;
  } catch (e) {
    await logError("bot-choice-router", e);
    return null;
  }
}

/**
 * Decides the assistant reply. First tries to route the message to a defined
 * FAQ pathway (built-in price list / colours, plus owner-defined FAQs) and
 * returns that exact answer; otherwise Claude answers conversationally,
 * grounded in the real range, prices, hours and brief. Also flags handoff.
 */
export async function generateBotReply(input: {
  history: BotMsg[];
  customerName?: string | null;
  isCustomer: boolean;
  voiceNote?: boolean;
}): Promise<{ reply: string; handoff: boolean } | null> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return null;

  const [brief, hours, products, faqs] = await Promise.all([
    getSetting("BOT_AI_BRIEF"),
    getSetting("BOT_HOURS"),
    prisma.product.findMany({ where: { active: true }, include: { colors: true }, orderBy: { name: "asc" } }),
    getBotFaqs(),
  ]);

  const priceList = products.length
    ? "Here's our current range:\n" +
      products
        .map(
          (p) =>
            `• ${p.name}${p.basePriceCents ? ` — from ${formatZAR(p.basePriceCents)}` : ""}` +
            (p.colors.length ? ` (${p.colors.map((c) => c.name).join(", ")})` : "")
        )
        .join("\n")
    : "";
  const coloursList = products.length
    ? products
        .filter((p) => p.colors.length)
        .map((p) => `${p.name}: ${p.colors.map((c) => c.name).join(", ")}`)
        .join("\n")
    : "";

  const builtins: { id: string; when: string; answer: string; handoff?: boolean }[] = [];
  if (priceList) builtins.push({ id: "builtin:pricelist", when: "asking about price, cost, how much, or a price list", answer: priceList });
  if (coloursList) builtins.push({ id: "builtin:colours", when: "asking which colours/colors are available", answer: `Our colours:\n${coloursList}` });

  const pathways = [
    ...builtins.map((b) => ({ id: b.id, when: b.when, answer: b.answer, handoff: b.handoff })),
    ...faqs.map((f) => ({ id: f.id, when: f.question, answer: f.answer, handoff: f.handoff })),
  ];
  const pathwayList = pathways.map((p) => `[${p.id}] ${p.when}`).join("\n") || "(none)";

  const who = input.customerName
    ? `You're chatting with ${input.customerName}${input.isCustomer ? ", an existing customer" : ""}.`
    : "";

  const system = `You are the WhatsApp assistant for Denago Cape Town, an authorised Denago electric golf-cart dealer and service centre in Cape Town, South Africa. ${who}

STYLE — sound like a warm, helpful human, not a bot:
- WhatsApp style: short replies (usually 1–3 sentences), South African English.
- Use the first name occasionally, not every message. The odd tasteful emoji is fine.
- Never sound scripted or repeat yourself; answer what they actually asked.

WHAT YOU KNOW:
Business hours (SA time): ${hours || "08:00–17:00"}, Mon–Fri.
${priceList ? priceList + "\n" : ""}${brief ? `\nAbout us / policies:\n${brief}\n` : ""}
DEFINED FAQ PATHWAYS — if the customer's message clearly matches one of these, use it (its exact answer will be sent):
${pathwayList}

HOW TO RESPOND — strict JSON only:
- If the message matches a pathway above: {"faqId": "<the id>", "handoff": <true|false>}
- Otherwise answer conversationally: {"faqId": null, "reply": "<your whatsapp message>", "handoff": <true|false>}

RULES:
- Only state facts given above. NEVER invent prices, specs, stock, dates or promises. If unsure, say you'll check with the team and hand off.
- Set handoff true when the customer wants to order/pay, book a specific date/test drive, has a complaint, asks something you don't know, or asks for a person.
${input.voiceNote ? "- This message arrived as a VOICE NOTE (transcribed). Reply naturally; it will then be handed to a human.\n" : ""}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        system,
        messages: sanitize(input.history).slice(-14),
      }),
    });
    if (!res.ok) {
      await logError("bot-ai", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const parsed = parseFirstJsonObject(String(json.content?.[0]?.text ?? "{}"));

    if (parsed.faqId) {
      const p = pathways.find((x) => x.id === parsed.faqId);
      if (p) {
        return {
          reply: personalize(p.answer, input.customerName),
          handoff: Boolean(p.handoff) || Boolean(parsed.handoff),
        };
      }
    }
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return { reply: personalize(parsed.reply.trim(), input.customerName), handoff: Boolean(parsed.handoff) };
    }
    return null;
  } catch (e) {
    await logError("bot-ai", e);
    return null;
  }
}

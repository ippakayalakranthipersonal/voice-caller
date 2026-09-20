import crypto from "crypto";
import express from "express";

const {
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: OWNER_ID, // your own Telegram chat ID (results are sent here)
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash-lite", // check aistudio.google.com for the current free model ID
  PUBLIC_URL,
  API_SECRET,
  OWNER_NAME = "my owner", // how the bot refers to you, e.g. "Kranthi"
  UPSTASH_REDIS_REST_URL: KV_URL, // optional: free Redis so links survive restarts
  UPSTASH_REDIS_REST_TOKEN: KV_TOKEN,
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({
  TELEGRAM_BOT_TOKEN: TOKEN,
  TELEGRAM_CHAT_ID: OWNER_ID,
  GEMINI_API_KEY,
  PUBLIC_URL,
  API_SECRET,
})) {
  if (!value) {
    console.error(`Missing ${name}. Add it in Render > Environment.`);
    process.exit(1);
  }
}

const BASE_URL = PUBLIC_URL.replace(/\/+$/, "");
// Telegram will send this secret with every webhook call so we can reject fakes.
const WEBHOOK_SECRET = crypto.createHash("sha256").update(API_SECRET).digest("hex");

const app = express();
app.use(express.json());

const HELP = `Hi! I can check people's availability for you.

Send me:
/ask Your question? | Follow-up if they say yes?

I'll give you a link to send. When they tap it, I chat with them and message you their answer.

Example:
/ask Are you free for a quick call this week? | What day and time works best?`;

// ---------------------------------------------------------------------------
// Tiny key-value store. Uses free Upstash Redis if configured, else memory.
// (Memory is wiped whenever a free Render server sleeps or redeploys.)
// ---------------------------------------------------------------------------
const mem = new Map();

async function kvSet(key, value, ttlSeconds) {
  const str = JSON.stringify(value);
  if (KV_URL && KV_TOKEN) {
    await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["SET", key, str, "EX", String(ttlSeconds)]),
    });
  } else {
    mem.set(key, str);
    setTimeout(() => mem.delete(key), ttlSeconds * 1000).unref();
  }
}

async function kvGet(key) {
  if (KV_URL && KV_TOKEN) {
    const r = await fetch(KV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${KV_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : null;
  }
  const str = mem.get(key);
  return str ? JSON.parse(str) : null;
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
let botUsername = null;

async function tg(method, body = {}) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(data));
    return data;
  } catch (err) {
    console.error(`Telegram ${method} error:`, err.message);
    return { ok: false };
  }
}

const send = (chat_id, text) => tg("sendMessage", { chat_id, text });

async function getBotUsername() {
  if (!botUsername) {
    const me = await tg("getMe");
    if (me.ok) botUsername = me.result.username;
  }
  return botUsername;
}

// Process one chat's messages in order, so quick replies never overlap.
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next
    .finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    })
    .catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Webhook: Telegram calls this for every message sent to your bot
// ---------------------------------------------------------------------------
app.post("/telegram", (req, res) => {
  if (req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200); // reply immediately so Telegram doesn't retry

  const msg = req.body?.message;
  if (!msg || !msg.chat) return;

  enqueue(msg.chat.id, () => handleMessage(msg)).catch((err) =>
    console.error("handleMessage failed:", err)
  );
});

app.get("/", (_req, res) => res.send("ok")); // health check

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const isOwner = String(chatId) === String(OWNER_ID);
  const name = msg.from?.first_name || "there";
  const text = (msg.text || "").trim();

  if (!text) {
    return send(chatId, "Sorry, I can only read text messages.");
  }

  // /start or /start <linkId>
  if (/^\/start(@\w+)?(\s|$)/i.test(text)) {
    const linkId = text.split(/\s+/)[1];
    if (linkId) return beginConversation(chatId, name, linkId);
    return send(
      chatId,
      isOwner ? HELP : "Hi! This bot works through a personal link. Please use the link you were sent."
    );
  }

  if (isOwner && /^\/ask(@\w+)?(\s|$)/i.test(text)) return createRequest(chatId, text);
  if (isOwner && /^\/help(@\w+)?(\s|$)/i.test(text)) return send(chatId, HELP);
  if (/^\/stop(@\w+)?(\s|$)/i.test(text)) return stopConversation(chatId, name);

  const conv = await kvGet(`conv:${chatId}`);
  if (!conv) {
    return send(
      chatId,
      isOwner
        ? HELP
        : "I don't have an open question for you right now. If you were expecting one, please ask for a new link."
    );
  }
  if (conv.done) return send(chatId, "This conversation is finished. Thank you!");
  return continueConversation(chatId, conv, text);
}

// Owner: /ask Question? | Follow-up?
async function createRequest(chatId, text) {
  const rest = text.replace(/^\/ask(@\w+)?\s*/i, "");
  const [question, ...more] = rest.split("|");
  const q = question.trim();
  const followUp = more.join("|").trim();

  if (!q) {
    return send(
      chatId,
      "Usage:\n/ask Your question? | Follow-up if yes?\n\nExample:\n/ask Are you free for a quick call this week? | What day and time works best?"
    );
  }

  const id = crypto.randomBytes(6).toString("base64url");
  await kvSet(`req:${id}`, { question: q, followUp, ownerName: OWNER_NAME }, 7 * 24 * 3600);

  const username = await getBotUsername();
  const link = `https://t.me/${username}?start=${id}`;
  return send(
    chatId,
    `Done! Send this link to the person:\n${link}\n\n` +
      `When they tap Start, I'll ask:\n"${q}"` +
      (followUp ? `\nIf they say yes, I'll then ask:\n"${followUp}"` : "") +
      `\n\nI'll message you here with the result. The link works for 7 days and can be used by several people.`
  );
}

// Anyone: opened a link
async function beginConversation(chatId, name, linkId) {
  const req = await kvGet(`req:${linkId}`);
  if (!req) {
    return send(chatId, "Sorry, this link has expired or isn't valid. Please ask for a new one.");
  }

  const opening =
    `Hi ${name}! I'm an AI assistant messaging on behalf of ${req.ownerName}. ` +
    `Your replies will be shared with them. You can send /stop at any time.\n\n${req.question}`;

  const conv = {
    ...req,
    name,
    opening,
    history: [], // Gemini format: { role: "user" | "model", text }
    transcript: [{ who: "assistant", text: opening }],
    turns: 0,
    done: false,
  };
  await kvSet(`conv:${chatId}`, conv, 24 * 3600);
  await send(chatId, opening);

  if (String(chatId) !== String(OWNER_ID)) {
    await send(OWNER_ID, `👋 ${name} opened your link.`);
  }
}

async function continueConversation(chatId, conv, text) {
  conv.history.push({ role: "user", text });
  conv.transcript.push({ who: "person", text });
  conv.turns += 1;

  await tg("sendChatAction", { chat_id: chatId, action: "typing" });

  let turn;
  try {
    turn = await askGemini(conv);
  } catch (err) {
    console.error("Gemini error:", err.message);
    conv.done = true;
    await kvSet(`conv:${chatId}`, conv, 24 * 3600);
    await send(chatId, "Sorry, I'm having a technical problem. I'll let them know.");
    await send(OWNER_ID, `⚠️ AI error while chatting with ${conv.name}. Their last message: "${text}"`);
    return;
  }

  const say = (turn.say || "").trim() || "Thank you!";
  conv.history.push({ role: "model", text: JSON.stringify(turn) });
  conv.transcript.push({ who: "assistant", text: say });

  // Safety cap so a chat can never run forever.
  const finished = Boolean(turn.done) || conv.turns >= 12;
  conv.done = finished;
  await kvSet(`conv:${chatId}`, conv, 24 * 3600);

  await send(chatId, say);
  if (finished) {
    await reportResult(conv, turn.done ? turn : { available: "unclear", notes: "Conversation ran long." });
  }
}

async function stopConversation(chatId, name) {
  const conv = await kvGet(`conv:${chatId}`);
  await send(chatId, "Okay, I won't message you again. Take care!");
  if (conv && !conv.done) {
    conv.done = true;
    await kvSet(`conv:${chatId}`, conv, 24 * 3600);
    await send(OWNER_ID, `🛑 ${name} stopped the conversation.`);
  }
}

async function reportResult(conv, turn) {
  const lines = [
    `✅ ${conv.name} replied`,
    `Question: ${conv.question}`,
    `Answer: ${turn.available || "unclear"}`,
  ];
  if (turn.time) lines.push(`Time: ${turn.time}`);
  if (turn.notes) lines.push(`Notes: ${turn.notes}`);

  console.log("RESULT:", JSON.stringify({ name: conv.name, ...turn, transcript: conv.transcript }));
  await send(OWNER_ID, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Gemini (free tier) is the brain. We ask for strict JSON every turn.
// ---------------------------------------------------------------------------
function buildSystemPrompt(c) {
  return `You are a friendly, concise assistant chatting on Telegram on behalf of ${c.ownerName}. You are messaging ${c.name}.
Today's date is ${new Date().toDateString()}.

You have ALREADY sent this opening message, so do not repeat it: "${c.opening}"

Your job:
1. Get the person's answer to the main question: "${c.question}"
2. ${
    c.followUp
      ? `If (and only if) the answer is yes, ask: "${c.followUp}". Get a specific answer and repeat it back to confirm before finishing. If a time is given without a time zone and it's unclear, ask which time zone.`
      : "If the answer is yes, confirm it and wrap up."
  }
3. If the answer is no, thank them politely and finish. Do not pressure them.

Rules:
- "say" is a chat message: 1 or 2 short sentences, plain text, no markdown, at most one emoji.
- Never invent facts or make commitments on behalf of ${c.ownerName}. If asked something you don't know, say ${c.ownerName} will follow up.
- If asked whether you are an AI, say yes.
- If they ask you to stop or seem annoyed, apologize and finish.
- If their message is off-topic or unclear, gently steer back to the question once.

Reply ONLY with JSON:
{"say": string, "done": boolean, "available": "yes"|"no"|"unclear", "time": string, "notes": string}
Set done=false while you still need information (leave available/time/notes empty).
Set done=true only when the conversation is over; "say" is then your short closing message.`;
}

async function askGemini(conv) {
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(conv) }] },
    contents: conv.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          say: { type: "STRING" },
          done: { type: "BOOLEAN" },
          available: { type: "STRING", enum: ["yes", "no", "unclear"] },
          time: { type: "STRING" },
          notes: { type: "STRING" },
        },
        required: ["say", "done"],
      },
    },
  };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);

  const data = await r.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ---------------------------------------------------------------------------
// Start up: tell Telegram where to send messages
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`Listening on :${PORT}`);
  const username = await getBotUsername();
  const wh = await tg("setWebhook", {
    url: `${BASE_URL}/telegram`,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message"],
  });
  console.log(`Bot: @${username} | Webhook: ${wh.ok ? "set" : "FAILED " + JSON.stringify(wh)}`);
});

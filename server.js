import "dotenv/config";
import fs from "fs";
import crypto from "crypto";
import express from "express";
import twilio from "twilio";

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash-lite", // check aistudio.google.com for the current free model ID
  PUBLIC_URL,
  API_SECRET,
  TELEGRAM_BOT_TOKEN, // optional, free notifications
  TELEGRAM_CHAT_ID, // optional
  SAY_VOICE, // optional, e.g. "Polly.Joanna" (default Twilio voice is used if empty)
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  GEMINI_API_KEY,
  PUBLIC_URL,
  API_SECRET,
})) {
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// In-memory call sessions (lost if the server restarts, which is fine for short calls)
const sessions = new Map();

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// Twilio signs every webhook; reject anything that isn't from Twilio.
function fromTwilio(req) {
  return twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    req.get("X-Twilio-Signature") || "",
    `${PUBLIC_URL}${req.originalUrl}`,
    req.body
  );
}

// ---------------------------------------------------------------------------
// TwiML helpers
// ---------------------------------------------------------------------------
const sayTag = (text) =>
  `<Say${SAY_VOICE ? ` voice="${esc(SAY_VOICE)}"` : ""}>${esc(text)}</Say>`;

// Say something, then listen for the person's spoken reply.
function listen(id, text) {
  const url = `${PUBLIC_URL}/voice?id=${id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${esc(url)}" method="POST" speechTimeout="auto" timeout="6" language="en-IN">
    ${sayTag(text)}
  </Gather>
  <Redirect method="POST">${esc(url)}</Redirect>
</Response>`;
}

// Say something, then hang up.
const bye = (text) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTag(text)}
  <Hangup/>
</Response>`;

// ---------------------------------------------------------------------------
// 1) Start a call:  POST /call   { to, question, followUp?, callerName? }
// ---------------------------------------------------------------------------
app.post("/call", async (req, res) => {
  if (req.get("x-api-secret") !== API_SECRET) return res.sendStatus(401);

  const { to, question, followUp = "", callerName = "someone" } = req.body;
  if (!to || !question) {
    return res.status(400).json({ error: "`to` and `question` are required" });
  }

  const id = crypto.randomUUID();
  const opening = `Hi, this is an automated assistant calling on behalf of ${callerName}. ${question}`;
  sessions.set(id, {
    id,
    to,
    callerName,
    question,
    followUp,
    opening,
    lastSay: opening,
    history: [], // Gemini format: { role: "user" | "model", text }
    transcript: [{ who: "assistant", text: opening }],
    started: false,
    silence: 0,
    done: false,
  });

  try {
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_URL}/voice?id=${id}`,
      method: "POST",
      statusCallback: `${PUBLIC_URL}/status?id=${id}`,
      statusCallbackEvent: ["completed"],
    });
    sessions.get(id).callSid = call.sid;
    res.json({ callSid: call.sid, status: call.status });
  } catch (err) {
    sessions.delete(id);
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2) Twilio calls this at the start of the call and after every spoken reply
// ---------------------------------------------------------------------------
app.post("/voice", async (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  res.type("text/xml");

  const s = sessions.get(req.query.id);
  if (!s) return res.send(bye("Sorry, something went wrong. Goodbye."));

  // First hit: greet and ask the main question.
  if (!s.started) {
    s.started = true;
    return res.send(listen(s.id, s.opening));
  }

  const heard = (req.body.SpeechResult || "").trim();

  // Nothing heard: re-prompt once, then give up.
  if (!heard) {
    s.silence += 1;
    if (s.silence >= 2) {
      await finish(s, { outcome: "no_response" });
      return res.send(bye("Sorry, I couldn't hear you. I'll try again later. Goodbye."));
    }
    return res.send(listen(s.id, `Sorry, I didn't catch that. ${s.lastSay}`));
  }
  s.silence = 0;

  s.history.push({ role: "user", text: heard });
  s.transcript.push({ who: "person", text: heard });

  let turn;
  try {
    turn = await askGemini(s);
  } catch (err) {
    console.error("Gemini error:", err.message);
    await finish(s, { outcome: "ai_error", notes: err.message.slice(0, 200) });
    return res.send(bye("Sorry, I'm having a technical problem. Goodbye."));
  }

  const say = (turn.say || "").trim() || "Thank you. Goodbye.";
  s.history.push({ role: "model", text: JSON.stringify(turn) });
  s.transcript.push({ who: "assistant", text: say });
  s.lastSay = say;

  if (turn.done) {
    await finish(s, {
      outcome: "completed",
      available: turn.available || "unclear",
      time: turn.time || null,
      notes: turn.notes || "",
    });
    return res.send(bye(say));
  }
  res.send(listen(s.id, say));
});

// ---------------------------------------------------------------------------
// 3) Twilio reports the final call status (no answer, busy, hung up early...)
// ---------------------------------------------------------------------------
app.post("/status", async (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  const s = sessions.get(req.query.id);
  if (s && !s.done) {
    const status = req.body.CallStatus;
    await finish(s, {
      outcome: status === "completed" ? "hung_up_before_answer_recorded" : status,
    });
  }
  sessions.delete(req.query.id);
  res.sendStatus(204);
});

// ---------------------------------------------------------------------------
// 4) Read all results:  GET /results
// ---------------------------------------------------------------------------
app.get("/results", (req, res) => {
  if (req.get("x-api-secret") !== API_SECRET) return res.sendStatus(401);
  if (!fs.existsSync("results.jsonl")) return res.json([]);
  res.json(
    fs
      .readFileSync("results.jsonl", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  );
});

app.get("/", (_req, res) => res.send("ok")); // health check for free hosts

// ---------------------------------------------------------------------------
// Gemini (free tier) is the brain. We ask for strict JSON every turn.
// ---------------------------------------------------------------------------
function buildSystemPrompt(s) {
  return `You are a friendly, concise phone assistant calling on behalf of ${s.callerName}.
Today's date is ${new Date().toDateString()}.

You have ALREADY said this opening line, so do not repeat it: "${s.opening}"
The person's replies are speech-to-text, so expect small transcription errors.

Your job:
1. Get the person's answer to the main question: "${s.question}"
2. ${
    s.followUp
      ? `If (and only if) the answer is yes, ask: "${s.followUp}". Get a specific answer and repeat it back to confirm before finishing.`
      : "If the answer is yes, confirm it and wrap up."
  }
3. If the answer is no, thank them politely and finish. Do not pressure them.

Rules (this is a live phone call):
- "say" is spoken aloud: 1 or 2 short sentences, no lists, markdown, or emoji.
- Never invent facts. If asked something you don't know, say ${s.callerName} will follow up.
- If asked whether you are an AI, say yes.
- If they ask you to stop calling or seem annoyed, apologize and finish.
- If it sounds like voicemail or nobody real is there, finish with available="unclear".

Reply ONLY with JSON:
{"say": string, "done": boolean, "available": "yes"|"no"|"unclear", "time": string, "notes": string}
Set done=false while you still need information (leave available/time/notes empty).
Set done=true only when the conversation is over; "say" is then your short goodbye.`;
}

async function askGemini(s) {
  const body = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(s) }] },
    contents: s.history.map((h) => ({ role: h.role, parts: [{ text: h.text }] })),
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
// Saving + notifying (Telegram is free; SMS from a trial number is not practical)
// ---------------------------------------------------------------------------
async function finish(s, fields) {
  if (s.done) return;
  s.done = true;
  await saveResult({
    callSid: s.callSid,
    to: s.to,
    question: s.question,
    ...fields,
    transcript: s.transcript,
  });
}

async function saveResult(result) {
  const row = { at: new Date().toISOString(), ...result };
  fs.appendFileSync("results.jsonl", JSON.stringify(row) + "\n");
  console.log("RESULT:", JSON.stringify(row, null, 2));

  const summary =
    row.outcome === "completed"
      ? `Call to ${row.to}\nAnswer: ${row.available}` +
        (row.time ? `\nTime: ${row.time}` : "") +
        (row.notes ? `\nNotes: ${row.notes}` : "")
      : `Call to ${row.to}: ${row.outcome}`;
  await notifyTelegram(summary);
}

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
  } catch (err) {
    console.error("Telegram failed (result is still saved):", err.message);
  }
}

app.listen(PORT, () => console.log(`Listening on :${PORT}`));

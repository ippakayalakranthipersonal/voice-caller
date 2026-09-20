# Telegram Availability Bot (100% free)

You send your Telegram bot a question. It gives you a link. The person taps the link, chats with the bot, and the bot (using Gemini) asks your question, asks a follow-up only if they say yes, and messages you the result.

No Twilio, no phone calls. Works on Android only.

```
You: /ask Are you free for a call this week? | What day and time works?
Bot: Here's a link to send.  ->  Person taps it, chats with bot
Bot -> You: Ravi replied. Answer: yes. Time: Friday 3 PM
```

## Update your existing setup (about 10 minutes)

You already have the GitHub repo, the Render service, the Telegram bot, and the Gemini key. You only replace one file.

### 1. Replace `server.js` on GitHub
1. Download the new **server.js** from the file card. Keep the exact name.
2. In Chrome, open your `voice-caller` repo on github.com.
3. Tap **Add file > Upload files**, choose the new `server.js`, then **Commit changes**. Same name means it overwrites the old one.
4. (Optional) Upload the new `package.json` the same way.

### 2. Check Render environment variables
In Render, open your service and go to **Environment**. These must exist:

| Name | Value |
|---|---|
| TELEGRAM_BOT_TOKEN | token from @BotFather |
| TELEGRAM_CHAT_ID | your own chat ID number (from @userinfobot) |
| GEMINI_API_KEY | your Gemini key |
| GEMINI_MODEL | gemini-3.5-flash-lite |
| API_SECRET | any long random text |
| PUBLIC_URL | https://voice-caller-1.onrender.com (no slash at the end) |
| OWNER_NAME | your first name (how the bot introduces you) |

The Twilio variables are no longer used. You can leave or delete them.

### 3. Deploy
Render may not auto-deploy because it doesn't have access to your GitHub. Open your service and tap **Manual Deploy > Deploy latest commit**. Wait for **Live**.

Then open **Logs**. You should see:
```
Listening on :10000
Bot: @your_bot_name | Webhook: set
```
If it says `Webhook: FAILED`, check `PUBLIC_URL` and `TELEGRAM_BOT_TOKEN`.

### 4. Test it
1. Open your bot in Telegram and send:
   ```
   /ask Are you free for a quick call this week? | What day and time works best?
   ```
2. The bot replies with a link. Tap it, then **Start**. You're now the "person" (test on yourself first).
3. Answer "yes", then "Friday at 3 PM".
4. You get a summary message from the bot: answer, time, notes.

To use it for real, send the link to the person. One link can be used by several people, and each gets their own separate chat.

## Commands

| Who | Command | What it does |
|---|---|---|
| You | `/ask Question? \| Follow-up?` | Creates a link. The follow-up is optional |
| You | `/task Describe what you want in your own words` | Creates a link for a longer, flexible conversation (see below) |
| You | `/help` | Shows help |
| Anyone | `/stop` | Ends the chat; you're told they stopped |

## Important limits (free hosting)

- **Slow first reply:** Render's free plan sleeps after about 15 minutes idle. The first message after that can take up to a minute. Optional fix: create a free monitor at **uptimerobot.com** that pings `https://voice-caller-1.onrender.com` every 5 minutes.
- **Links can stop working:** without the option below, links and chats are kept in memory, and a sleep, restart, or redeploy erases them. Then you just create a new link.
- **Person needs Telegram** and must tap your link once. Bots can't message strangers first.
- **Privacy:** what people type goes to Gemini's free tier, which may use data to improve Google products. Don't use it for anything sensitive. The bot tells people it's an AI and that replies are shared with you.
- Only send the link to people who expect it.

## Optional: make links survive restarts (free Redis)

1. Sign up at **upstash.com** (it has a free plan) and create a **Redis** database.
2. On the database page, find the **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Add both as environment variables in Render, then redeploy. No code changes needed.

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot never answers you | Check Render Logs. If there's no "Webhook: set", fix `PUBLIC_URL` and the bot token, then redeploy |
| You get the help message instead of a link | Your `TELEGRAM_CHAT_ID` doesn't match your account, so the bot doesn't recognize you as the owner |
| "Missing ..." in Logs | An environment variable is absent or misspelled |
| "AI error" message | Wrong or missing `GEMINI_API_KEY`, or a wrong `GEMINI_MODEL`. Pick a current Flash/Flash-Lite model in AI Studio |
| Link says "expired" | The free server restarted. Send `/ask` again, or set up Upstash above |
| No answer for a minute after idle | The free server is waking up. Wait, or use UptimeRobot |


## Different questions and long conversations: `/task`

`/ask` is for one question with an optional follow-up. For anything longer, use `/task` and simply describe what you want, like briefing an assistant:

```
/task Ask about their availability next week, their time zone, and whether they prefer a phone call or video meeting. Be friendly and ask one thing at a time.
```

```
/task Collect feedback on yesterday's workshop: what they liked, what to improve, and a 1 to 5 rating. Keep it short and thank them at the end.
```

```
/task Screen this candidate: current role, notice period, expected salary, and preferred work location. Be polite and professional.
```

**What happens**
1. The bot gives you a link, as before.
2. When the person taps Start, the AI writes its own opening question from your instructions, asks one thing at a time, follows up on vague answers, and never repeats questions.
3. When it has everything, it says goodbye and messages you a **summary**, a list of **answers**, and the **full conversation**.

**Tips for good instructions**
- List exactly what information you want.
- Say the tone you want (friendly, formal, short).
- Say what the AI must not do (for example "don't promise anything about salary").
- The person can reply in their own language and the AI will follow.

**Limits**
- A `/task` conversation ends after 40 messages from the person by default. To change this, add an environment variable `MAX_TURNS` in Render (for example `60`).
- Every message uses one free Gemini request, so very long chats or many people at once can hit the free-tier limit. If you see an "AI error" message, wait a minute and retry.
- People can reply hours later. The chat stays open for 24 hours after their last message.
- Send `/stop` (the person, or you in your own chat) to end a conversation early. For tasks you still get the transcript so far.

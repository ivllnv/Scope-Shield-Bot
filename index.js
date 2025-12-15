// Environment Setup
import "dotenv/config";

import express from "express";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import axios from "axios";
import fs from "fs";

// Environment Variables
const {
  TELEGRAM_TOKEN,
  OPENAI_API_KEY,
  ASSISTANT_ID,
  BOT_SECRET,
  BOT_USERNAME = "ScopeShield_Bot",
  PORT = 3000,
  RENDER_EXTERNAL_URL
} = process.env;

if (
  !TELEGRAM_TOKEN ||
  !OPENAI_API_KEY ||
  !ASSISTANT_ID ||
  !BOT_SECRET ||
  !RENDER_EXTERNAL_URL
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// Initialize Services
const app = express();
app.use(express.json());

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Thread Persistence
// One thread per (chatId + userId)
const THREADS_FILE = "/data/threads.json";
let threads = {};

if (fs.existsSync(THREADS_FILE)) {
  try {
    threads = JSON.parse(fs.readFileSync(THREADS_FILE, "utf8"));
  } catch {
    threads = {};
  }
}

function saveThreads() {
  fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
}

function getThreadKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

async function getOrCreateThread(chatId, userId) {
  const key = getThreadKey(chatId, userId);

  if (threads[key]) {
    return threads[key];
  }

  const thread = await openai.beta.threads.create();
  threads[key] = thread.id;
  saveThreads();

  return thread.id;
}

// Assistant Interaction
async function runAssistant(chatId, userId, userText) {
  const threadId = await getOrCreateThread(chatId, userId);

  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: userText,
  });

  const run = await openai.beta.threads.runs.createAndPoll(threadId, {
    assistant_id: ASSISTANT_ID,
  });

  if (run.status !== "completed") {
    throw new Error(`Assistant run failed with status: ${run.status}`);
  }

  const messages = await openai.beta.threads.messages.list(threadId, {
    limit: 5,
  });

  const assistantMessage = messages.data.find(
    (m) => m.role === "assistant"
  );

  return (
    assistantMessage?.content?.[0]?.text?.value ||
    "No response generated."
  );
}

// Telegram Webhook Setup
const WEBHOOK_URL = `${RENDER_EXTERNAL_URL}/webhook/${BOT_SECRET}`;

await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: WEBHOOK_URL }),
});

// Webhook Endpoint
app.post(`/webhook/${BOT_SECRET}`, async (req, res) => {
  const message = req.body?.message;
  if (!message || !message.text) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const userId = message.from?.id;
  const chatType = message.chat.type;
  let text = message.text.trim();

  const isPrivate = chatType === "private";
  const mentionTag = `@${BOT_USERNAME}`;

  // In group chats, respond only when mentioned
  if (!isPrivate && !text.includes(mentionTag)) {
    return res.sendStatus(200);
  }

  // Remove mention from message text
  if (!isPrivate) {
    text = text.replace(mentionTag, "").trim();
  }

  try {
    const reply = await runAssistant(chatId, userId, text);
    await bot.sendMessage(chatId, reply, {
      reply_to_message_id: message.message_id,
    });
  } catch (err) {
    console.error("Assistant error:", err.message);
    await bot.sendMessage(chatId, "Error processing your request.");
  }

  res.sendStatus(200);
});

// Health Check Endpoint
app.get("/", (req, res) => {
  res.send("Scope Shield Telegram bot is running.");
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// Self-Ping (Render Keep-Alive)
setInterval(async () => {
  try {
    await axios.get(RENDER_EXTERNAL_URL);
  } catch (err) {
    console.error("Self-ping failed:", err.message);
  }
}, 180000);
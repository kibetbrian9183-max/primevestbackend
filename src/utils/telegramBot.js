const axios = require("axios");

function apiUrl(method) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function call(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn(`[telegramBot] TELEGRAM_BOT_TOKEN is not set — skipping ${method}`);
    return { ok: false, skipped: true };
  }
  try {
    const { data } = await axios.post(apiUrl(method), body, { timeout: 10000 });
    return data;
  } catch (err) {
    console.error(`[telegramBot] ${method} failed:`, err.response?.data || err.message);
    return { ok: false, error: err.response?.data || err.message };
  }
}

/** Sends a new message with an inline keyboard. Returns the sent message (so its message_id can be stored/used to edit later, though this integration re-finds by chat+text where needed). */
function sendMessage(text, inlineKeyboard) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.warn("[telegramBot] TELEGRAM_CHAT_ID is not set — skipping sendMessage");
    return Promise.resolve({ ok: false, skipped: true });
  }
  return call("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

/** Edits an existing message's text and/or keyboard — used after approve/reject/mark-paid so the buttons update in place instead of leaving stale ones an admin could tap again. */
function editMessage(chatId, messageId, text, inlineKeyboard) {
  return call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard || [] },
  });
}

/** Acknowledges a button press — Telegram shows a small toast with `text`. Every callback query must be answered or the button spins forever on the admin's end. */
function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  return call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

module.exports = { sendMessage, editMessage, answerCallbackQuery };

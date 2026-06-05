import { parseTaskManagement, telegramPrompt } from "./task-commands.mjs";
import { createTaskProposal } from "./task-proposal.mjs";

function escapeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g, "<i>$1</i>");
}

function markdownToTelegramHtml(value) {
  const text = String(value ?? "").trim();
  const chunks = text.split(/(```[\s\S]*?```)/g);
  return chunks.map((chunk) => {
    const code = chunk.match(/^```[^\n]*\n?([\s\S]*?)```$/);
    if (code) return `<pre>${escapeHtml(code[1].trim())}</pre>`;
    return formatInlineMarkdown(chunk);
  }).join("");
}

function formatTask(task) {
  const status = task.confirmed ? task.status : "pending confirmation";
  return `${task.id}\n  ${status} · ${task.cron}\n  ${escapeText(task.prompt).slice(0, 160)}`;
}

function formatTasks(tasks) {
  if (!tasks.length) return "No scheduled tasks.";
  return tasks.map(formatTask).join("\n\n");
}

export function startTelegramBot({ token, allowedChatId, taskStore, runner }) {
  if (!token) return null;
  let offset = 0;
  let stopped = false;
  const base = `https://api.telegram.org/bot${token}`;

  async function api(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  }

  async function reply(chatId, text) {
    const raw = String(text ?? "").slice(0, 3900);
    const html = markdownToTelegramHtml(raw);
    try {
      await api("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true });
    } catch (error) {
      await api("sendMessage", { chat_id: chatId, text: raw, disable_web_page_preview: true });
    }
  }

  function chatAllowed(chatId) {
    return !allowedChatId || String(chatId) === String(allowedChatId);
  }

  function tasksForChat(chatId) {
    return taskStore.list().filter((task) => String(task.telegramChatId) === String(chatId));
  }

  function candidateTasksForCommand(chatId, type) {
    const tasks = tasksForChat(chatId);
    if (type === "confirm") return tasks.filter((task) => !task.confirmed);
    if (type === "enable") return tasks.filter((task) => task.status !== "enabled" || !task.confirmed);
    if (type === "disable") return tasks.filter((task) => task.status === "enabled" && task.confirmed);
    if (type === "delete") return tasks;
    return [];
  }

  function commandUsage(type) {
    return `/${type} <task_id>`;
  }

  async function handleTaskCommand(chatId, command) {
    if (command.type === "list") {
      await reply(chatId, formatTasks(tasksForChat(chatId)));
      return;
    }
    if (command.type === "schedule-help") {
      await reply(chatId, "Usage: /schedule <request>\nExample: /schedule every day at 9am summarize project status");
      return;
    }
    if (command.type === "new") {
      if (!runner.isIdle()) {
        await reply(chatId, "pi is busy. Try /new again after the current response finishes.");
        return;
      }
      await runner.resetTelegram();
      await reply(chatId, "Started a new Telegram session.");
      return;
    }
    if (command.type === "schedule") {
      if (!runner.isIdle()) await reply(chatId, "pi is busy. Task creation request was queued and will run shortly.");
      const proposal = await createTaskProposal({
        text: command.text,
        source: "telegram",
        telegramChatId: String(chatId),
        taskStore,
        run: (input) => runner.enqueueEphemeral(input),
        isolated: true,
        createIsolatedBinding: (input) => runner.createTaskSessionBinding(input),
      });
      if (!proposal.task) {
        await reply(chatId, proposal.proposal?.question || "pi needs more information to create this task.");
        return;
      }
      await reply(chatId, `Created pending task ${proposal.task.id}. Confirm with:\n/confirm ${proposal.task.id}\n\n${formatTask(proposal.task)}`);
      return;
    }
    let task = command.id ? taskStore.get(command.id) : null;
    if (!command.id) {
      const candidates = candidateTasksForCommand(chatId, command.type);
      if (candidates.length === 1) task = candidates[0];
      else {
        await reply(chatId, candidates.length ? `Multiple matching tasks. Use ${commandUsage(command.type)}.` : `No matching task for /${command.type}.`);
        return;
      }
    }
    if (!task) {
      await reply(chatId, "Task not found.");
      return;
    }
    if (command.type === "confirm") {
      await taskStore.update(task.id, { confirmed: true, status: "enabled" });
      await reply(chatId, `Confirmed and enabled task ${task.id}.`);
      return;
    }
    if (command.type === "enable") {
      await taskStore.update(task.id, { status: "enabled", confirmed: true });
      await reply(chatId, `Enabled task ${task.id}.`);
      return;
    }
    if (command.type === "disable") {
      await taskStore.update(task.id, { status: "disabled" });
      await reply(chatId, `Disabled task ${task.id}.`);
      return;
    }
    if (command.type === "delete") {
      await taskStore.delete(task.id);
      await reply(chatId, `Deleted task ${task.id}.`);
    }
  }

  async function handleMessage(message) {
    const chatId = message.chat?.id;
    if (!chatId || !chatAllowed(chatId)) return;
    const text = message.text?.trim();
    if (!text) return;

    const command = parseTaskManagement(text);
    if (command) {
      await handleTaskCommand(chatId, command);
      return;
    }
    if (text.startsWith("/")) {
      await reply(chatId, "Unsupported command. Supported: /new, /schedule, /tasks, /confirm, /enable, /disable, /delete.");
      return;
    }

    if (!runner.isIdle()) {
      await reply(chatId, "pi is busy. Your message was queued and will run shortly.");
    }
    const result = await runner.enqueueTelegram({ text: telegramPrompt(text), source: "telegram", telegramChatId: String(chatId) });
    await reply(chatId, result.text || result.summary || "Done.");
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleMessage(update.message).catch((error) => {
            console.error("telegram message failed:", error);
            const chatId = update.message?.chat?.id;
            if (chatId && chatAllowed(chatId)) void reply(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
          });
        }
      } catch (error) {
        console.error("telegram poll failed:", error instanceof Error ? error.message : error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  void poll();
  return {
    sendMessage: reply,
    stop: () => { stopped = true; },
  };
}

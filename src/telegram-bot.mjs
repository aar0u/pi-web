import { parseTaskManagement, telegramPrompt } from './task-commands.mjs';
import { createTaskProposal } from './task-proposal.mjs';

let botIdentity = null;

export function startTelegramBot({ token, allowedChatIds = [], taskStore, runner }) {
  if (!token) return null;
  const allowedChats = new Set(allowedChatIds.map((chatId) => String(chatId)));
  if (allowedChats.size === 0) throw new Error('Telegram bot requires at least one allowed chat id');
  let offset = 0;
  let stopped = false;
  const base = `https://api.telegram.org/bot${token}`;

  async function api(method, body) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
    return data.result;
  }

  async function sendBotMessage(chatId, text) {
    const raw = String(text ?? '').slice(0, 3900);
    const html = markdownToTelegramHtml(raw);
    try {
      await api('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (error) {
      await api('sendMessage', { chat_id: chatId, text: raw, disable_web_page_preview: true });
    }
  }

  function chatAllowed(chatId) {
    return allowedChats.has(String(chatId));
  }

  function tasksForChat(chatId) {
    return taskStore.list().filter((task) => String(task.telegramChatId) === String(chatId));
  }

  function candidateTasksForCommand(chatId, type) {
    const tasks = tasksForChat(chatId);
    if (type === 'confirm') return tasks.filter((task) => !task.confirmed);
    if (type === 'enable') return tasks.filter((task) => task.status !== 'enabled' || !task.confirmed);
    if (type === 'disable') return tasks.filter((task) => task.status === 'enabled' && task.confirmed);
    if (type === 'delete') return tasks;
    return [];
  }

  function commandUsage(type) {
    return `/${type} <task_id>`;
  }

  async function poll() {
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          await handleUpdate(update).catch((error) => {
            console.error('telegram update failed:', error);
            const chatId = getUpdateChatId(update);
            if (chatId && chatAllowed(chatId)) void sendBotMessage(chatId, `Error: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
          });
        }
      } catch (error) {
        console.error('telegram poll failed:', error instanceof Error ? error.message : error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  async function handleUpdate(update) {
    const chatId = getUpdateChatId(update);
    if (!chatId) return;

    if (!chatAllowed(chatId)) {
      logIncomingUpdate(update);
      console.warn(`telegram blocked chat_id=${chatId}`);
      return;
    }

    if (update.callback_query) {
      logIncomingCallback(update.callback_query);
      // pi-hub has no callback handlers yet
      return;
    }

    if (update.message) {
      if (prepareMessageForHandling(update.message)) {
        await handlePreparedMessage(update, chatId);
      } else {
        logIncomingUpdate(update);
      }
    }
  }

  async function handlePreparedMessage(update, chatId) {
    logIncomingMessage(update.message);
    const text = update.message.normalizedText;

    if (text === '/help') {
      await sendBotMessage(chatId, helpText());
      return;
    }

    if (isSlashCommand(text)) {
      const command = parseTaskManagement(text);
      if (command) {
        await handleTaskCommand(chatId, command);
        return;
      }
      // Unknown slash commands are pi prompts, e.g. /serenity skill invocations.
    }

    if (!runner.isIdle()) {
      await sendBotMessage(chatId, 'pi is busy. Your message was queued and will run shortly.');
    }
    const result = await runner.enqueueTelegram({ text: telegramPrompt(text), source: 'telegram', telegramChatId: String(chatId) });
    const responseText = result.text || result.summary;
    if (responseText) await sendBotMessage(chatId, responseText);
  }

  async function handleTaskCommand(chatId, command) {
    if (command.type === 'list') {
      await sendBotMessage(chatId, formatTasks(tasksForChat(chatId)));
      return;
    }
    if (command.type === 'schedule-help') {
      await sendBotMessage(chatId, 'Usage: /schedule <request>\nExample: /schedule every day at 9am summarize project status');
      return;
    }
    if (command.type === 'new') {
      if (!runner.isIdle()) {
        await sendBotMessage(chatId, 'pi is busy. Try /new again after the current response finishes.');
        return;
      }
      await runner.resetTelegram();
      await sendBotMessage(chatId, 'Started a new Telegram session.');
      return;
    }
    if (command.type === 'schedule') {
      if (!runner.isIdle()) await sendBotMessage(chatId, 'pi is busy. Task creation request was queued and will run shortly.');
      const proposal = await createTaskProposal({
        text: command.text,
        source: 'telegram',
        telegramChatId: String(chatId),
        taskStore,
        run: (input) => runner.enqueueEphemeral(input),
        isolated: true,
        createIsolatedBinding: (input) => runner.createTaskSessionBinding(input),
      });
      if (!proposal.task) {
        await sendBotMessage(chatId, proposal.proposal?.question || 'pi needs more information to create this task.');
        return;
      }
      await sendBotMessage(chatId, `Created pending task ${proposal.task.id}. Confirm with:\n/confirm ${proposal.task.id}\n\n${formatTask(proposal.task)}`);
      return;
    }
    let task = command.id ? taskStore.get(command.id) : null;
    if (!command.id) {
      const candidates = candidateTasksForCommand(chatId, command.type);
      if (candidates.length === 1) task = candidates[0];
      else {
        await sendBotMessage(chatId, candidates.length ? `Multiple matching tasks. Use ${commandUsage(command.type)}.` : `No matching task for /${command.type}.`);
        return;
      }
    }
    if (!task) {
      await sendBotMessage(chatId, 'Task not found.');
      return;
    }
    if (command.type === 'confirm') {
      await taskStore.update(task.id, { confirmed: true, status: 'enabled' });
      await sendBotMessage(chatId, `Confirmed and enabled task ${task.id}.`);
      return;
    }
    if (command.type === 'enable') {
      await taskStore.update(task.id, { status: 'enabled', confirmed: true });
      await sendBotMessage(chatId, `Enabled task ${task.id}.`);
      return;
    }
    if (command.type === 'disable') {
      await taskStore.update(task.id, { status: 'disabled' });
      await sendBotMessage(chatId, `Disabled task ${task.id}.`);
      return;
    }
    if (command.type === 'delete') {
      await taskStore.delete(task.id);
      await sendBotMessage(chatId, `Deleted task ${task.id}.`);
    }
  }

  async function init() {
    botIdentity = await api('getMe', {});
    console.log('telegram bot identity', {
      id: botIdentity.id,
      username: botIdentity.username ? `@${botIdentity.username}` : undefined,
      first_name: botIdentity.first_name,
    });
    await poll();
  }

  void init().catch((error) => {
    console.error('telegram bot init failed:', error instanceof Error ? error.message : error);
  });
  return {
    sendMessage: sendBotMessage,
    stop: () => { stopped = true; },
  };
}

function escapeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g, '<i>$1</i>');
}

function markdownToTelegramHtml(value) {
  const text = String(value ?? '').trim();
  const chunks = text.split(/(```[\s\S]*?```)/g);
  return chunks.map((chunk) => {
    const code = chunk.match(/^```[^\n]*\n?([\s\S]*?)```$/);
    if (code) return `<pre>${escapeHtml(code[1].trim())}</pre>`;
    return formatInlineMarkdown(chunk);
  }).join('');
}

function formatTask(task) {
  const status = task.confirmed ? task.status : 'pending confirmation';
  return `${task.id}\n  ${status} · ${task.cron}\n  ${escapeText(task.prompt).slice(0, 160)}`;
}

function formatTasks(tasks) {
  if (!tasks.length) return 'No scheduled tasks.';
  return tasks.map(formatTask).join('\n\n');
}

function getUpdateChatId(update) {
  return update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
}

function logIncomingUpdate(update) {
  const chatId = getUpdateChatId(update) ?? 'unknown';
  const from = formatUser(update.callback_query?.from ?? update.message?.from);
  console.log(`telegram incoming update chat_id=${chatId} from=${from}`);
}

function logIncomingMessage(message) {
  const chatId = message.chat?.id ?? 'unknown';
  const reasons = [];
  if (isSlashCommand(message.text)) reasons.push('slash_command');
  if (mentionsThisBot(message.text)) reasons.push(`@${botUsername()}`);
  if (repliesToThisBot(message)) reasons.push(`reply_to_@${botUsername()}`);
  console.log(`telegram incoming message chat_id=${chatId} from=${formatUser(message.from)} reason=${reasons.join(',') || 'direct'} text=${message.text}`);
}

function logIncomingCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id ?? 'unknown';
  console.log(`telegram incoming callback chat_id=${chatId} from=${formatUser(callbackQuery.from)} data=${callbackQuery.data}`);
}

function prepareMessageForHandling(message) {
  if (message.from?.is_bot) return false;
  const text = message.text?.trim();
  if (!text) return false;
  if (isSlashCommand(text)) {
    if (!commandForThisBot(text, message)) return false;
    message.normalizedText = stripCommandTarget(text);
    return true;
  }

  if (!isGroupChat(message)) {
    message.normalizedText = text;
    return true;
  }

  if (!mentionsThisBot(text) && !repliesToThisBot(message)) return false;
  message.normalizedText = stripBotMention(text);
  return Boolean(message.normalizedText);
}

function helpText() {
  return 'Available commands:\n/new\n/schedule <request>\n/tasks\n/confirm <task_id>\n/enable <task_id>\n/disable <task_id>\n/delete <task_id>\n/help';
}

function botUsername() {
  return botIdentity?.username ? String(botIdentity.username).toLowerCase() : '';
}

function botMention() {
  const username = botUsername();
  return username ? `@${username}` : '';
}

function isGroupChat(message) {
  return ['group', 'supergroup'].includes(message.chat?.type);
}

function commandTarget(text) {
  const match = String(text || '').match(/^\/\w+(?:@(\w+))?(?:\s|$)/);
  return match ? (match[1] || '') : null;
}

function isSlashCommand(text) {
  return commandTarget(text) !== null;
}

function commandForThisBot(text, message) {
  const target = commandTarget(text);
  if (target === null) return false;
  if (target) return target.toLowerCase() === botUsername();
  return true;
}

function stripCommandTarget(text) {
  const username = botUsername();
  if (!username) return text;
  return String(text || '').replace(new RegExp(`^(/\\w+)@${username}(?=\\s|$)`, 'i'), '$1').trim();
}

function mentionsThisBot(text) {
  const mention = botMention();
  return Boolean(mention && String(text || '').toLowerCase().includes(mention));
}

function repliesToThisBot(message) {
  return Boolean(botIdentity?.id && message.reply_to_message?.from?.id === botIdentity.id);
}

function stripBotMention(text) {
  const mention = botMention();
  if (!mention) return text;
  return String(text || '').replace(new RegExp(`(^|\\s)${mention}\\b`, 'ig'), ' ').trim();
}

function formatUser(user) {
  return user?.username ? `@${user.username}` : user?.id ?? 'unknown';
}

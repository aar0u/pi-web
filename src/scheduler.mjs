import { cronMatches, minuteKey } from "./cron.mjs";

const DEFAULT_INTERVAL_MS = 30_000;

function summaryFromState(state) {
  const last = state?.messages?.[state.messages.length - 1];
  const text = last?.text || "";
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function startScheduler({ taskStore, runner, intervalMs = DEFAULT_INTERVAL_MS, notifyTelegram = null }) {
  let timer = null;
  let running = false;

  async function notifyTaskTelegram(task, text) {
    if (!notifyTelegram || !task.telegramChatId) return;
    try {
      await notifyTelegram(task.telegramChatId, text);
    } catch (error) {
      console.error("scheduled task telegram notification failed:", error instanceof Error ? error.message : error);
    }
  }

  async function runDueTask(task, now) {
    const runKey = minuteKey(now);
    await taskStore.update(task.id, { dueAt: now.toISOString(), lastRunKey: runKey });
    if (!runner.isIdle()) return;

    const startedAt = new Date().toISOString();
    await taskStore.update(task.id, { dueAt: null, lastRunAt: startedAt });
    try {
      const result = await runner.runTask({
        text: `[Scheduled task ${task.id}]\n${task.prompt}`,
        source: "scheduler",
        task,
      });
      const finishedAt = new Date().toISOString();
      const summary = summaryFromState(result.state) || "Completed";
      const notification = result.text || summary;
      const run = { taskId: task.id, source: "scheduler", status: "success", startedAt, finishedAt, summary, sessionFile: task.sessionFile, sessionId: task.sessionId };
      await taskStore.appendRun(run);
      await taskStore.update(task.id, { lastResult: run });
      await notifyTaskTelegram(task, `Scheduled task ${task.id} completed.\n\n${notification}`);
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      const run = { taskId: task.id, source: "scheduler", status: "error", startedAt, finishedAt, error: message, sessionFile: task.sessionFile, sessionId: task.sessionId };
      await taskStore.appendRun(run);
      await taskStore.update(task.id, { lastResult: run, ...(task.sessionFile ? {} : { status: "disabled" }) });
      await notifyTaskTelegram(task, `Scheduled task ${task.id} failed.\n\n${message}`);
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const nowKey = minuteKey(now);
      for (const task of taskStore.list().reverse()) {
        if (task.status !== "enabled" || !task.confirmed) continue;
        const deferred = task.dueAt && new Date(task.dueAt) <= now;
        const dueByCron = cronMatches(task.cron, now) && task.lastRunKey !== nowKey;
        if (!deferred && !dueByCron) continue;
        await runDueTask(task, now);
      }
    } catch (error) {
      console.error("scheduler tick failed:", error);
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

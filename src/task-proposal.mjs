import { HttpError } from "./http.mjs";
import { assertCron } from "./cron.mjs";

function lastAssistantText(state) {
  const messages = state?.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && message.text) return message.text;
  }
  return "";
}

function extractJsonObject(text) {
  const value = String(text || "").trim();
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  if (!candidate || !candidate.trim()) throw new HttpError(400, "pi did not return a task proposal JSON object");
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new HttpError(400, `Could not parse pi task proposal: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function proposalPrompt(text) {
  const now = new Date();
  return `You are helping to create a scheduled task from natural language.
Current local time: ${now.toString()}

User request:
${text}

Return ONLY one JSON object, no Markdown and no extra text.
If enough information exists, use this shape:
{"cron":"5-field cron expression","prompt":"the exact prompt to run when scheduled","title":"short label","reason":"brief explanation"}

If the schedule or task is ambiguous, use this shape:
{"error":"missing_information","question":"one concise clarification question"}

Rules:
- Use standard 5-field cron: minute hour day month weekday.
- Do not include seconds.
- Preserve the user's task intent in prompt.
- If the user says daily/每天 without a time, ask a clarification question.
- If timezone matters, mention it in reason, but still output valid JSON only.`;
}

function sessionBinding(state) {
  return {
    cwd: state?.cwd || null,
    sessionFile: state?.sessionFile || null,
    sessionId: state?.sessionId || null,
    sessionName: state?.sessionName || null,
  };
}

export async function createTaskProposal({ text, source, telegramChatId = null, taskStore, run, binding: existingBinding = null, isolated = false, createIsolatedBinding = null }) {
  if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "Task request is empty");
  const result = await run({ text: proposalPrompt(text.trim()), source, telegramChatId });
  const assistantText = lastAssistantText(result.state) || result.summary || "";
  const proposal = extractJsonObject(assistantText);
  if (proposal.error) return { task: null, proposal, assistantText, state: result.state };

  const cron = assertCron(proposal.cron);
  if (typeof proposal.prompt !== "string" || !proposal.prompt.trim()) throw new HttpError(400, "pi task proposal did not include a prompt");
  if (isolated && typeof createIsolatedBinding !== "function") throw new HttpError(500, "Isolated task sessions are not available");
  const binding = isolated ? await createIsolatedBinding({ source, telegramChatId }) : (existingBinding || sessionBinding(result.state));
  const task = await taskStore.create({
    prompt: proposal.prompt.trim(),
    cron,
    source,
    confirmed: false,
    status: "disabled",
    telegramChatId,
    ...binding,
  });
  return { task, proposal: { ...proposal, cron, prompt: proposal.prompt.trim(), isolated }, assistantText, state: result.state };
}

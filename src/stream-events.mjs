import { textOfContent } from "./session-state.mjs";
import { writeNdjson } from "./http.mjs";

function shortText(value, max = 400) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolMessage(phase, toolName, details) {
  const icon = phase === "done" ? "✓" : phase === "queued" ? "…" : "▶";
  const suffix = details === undefined ? "" : ` ${shortText(details)}`;
  const label = phase === "done" ? "done" : phase === "queued" ? "queued" : "running";
  return `${icon} ${toolName} ${label}${suffix}`;
}

function toolPreview(details) {
  return details === undefined ? "" : shortText(details);
}

function argsText(args) {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? "");
  } catch {
    return String(args ?? "");
  }
}

function skillLabel(args) {
  const name = argsText(args).match(/\/skills\/([^/\s"']+)/)?.[1];
  return name ? `skill:${name}` : "";
}

function subscribePromptEventSink(session, { write = null, getState = null, onEvent = null } = {}) {
  return session.subscribe((event) => {
    switch (event.type) {
      case "message_start":
        write?.({ type: "message_start" });
        return;
      case "message_update":
        writeAssistantUpdate(write, event.assistantMessageEvent, onEvent);
        return;
      case "tool_execution_start":
        write?.({
          type: "tool",
          phase: "running",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          preview: toolPreview(event.args),
          message: toolMessage("running", event.toolName, event.args),
        });
        return;
      case "tool_execution_update":
        write?.({ type: "tool", phase: "update", toolCallId: event.toolCallId, toolName: event.toolName, message: textOfContent(event.partialResult?.content) });
        return;
      case "tool_execution_end": {
        const resultText = event.isError ? "error" : textOfContent(event.result?.content);
        write?.({
          type: "tool",
          phase: "done",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          preview: toolPreview(resultText),
          message: toolMessage("done", event.toolName, resultText),
        });
        return;
      }
      case "agent_end":
        if (getState) write?.({ type: "state", state: getState() });
        return;
      default:
        return;
    }
  });
}

export function observePromptEvents(session, onEvent) {
  return subscribePromptEventSink(session, { onEvent });
}

export function subscribePromptEvents(session, res, getState, onEvent = null) {
  return subscribePromptEventSink(session, { write: (event) => writeNdjson(res, event), getState, onEvent });
}

function writeAssistantUpdate(write, update, onEvent = null) {
  if (update?.type === "text_delta") {
    write?.({ type: "delta", delta: update.delta });
    return;
  }
  if (update?.type === "thinking_start") {
    write?.({ type: "tool", phase: "running", toolName: "thinking", contentIndex: update.contentIndex });
    return;
  }
  if (update?.type === "thinking_delta") {
    write?.({ type: "tool", phase: "update", toolName: "thinking", contentIndex: update.contentIndex, message: update.delta ?? update.thinking });
    return;
  }
  if (update?.type === "thinking_end") {
    write?.({ type: "tool", phase: "done", toolName: "thinking", contentIndex: update.contentIndex, message: update.content });
    return;
  }
  if (update?.type === "toolcall_start") {
    write?.({ type: "tool", phase: "queued", contentIndex: update.contentIndex });
    return;
  }
  if (update?.type === "toolcall_end" && update.toolCall) {
    const label = skillLabel(update.toolCall.arguments);
    if (label) onEvent?.("tool", `${label} called`);
    write?.({
      type: "tool",
      phase: "queued",
      toolCallId: update.toolCall.id,
      contentIndex: update.contentIndex,
      toolName: update.toolCall.name,
      preview: toolPreview(update.toolCall.arguments),
      message: toolMessage("queued", update.toolCall.name, update.toolCall.arguments),
    });
  }
}

function commandText(text) {
  return String(text || "")
    .replace(/\n\n\[Telegram constraints:[\s\S]*?\]\s*$/i, "")
    .trim();
}

export function parseTaskCreateRequest(text) {
  const value = commandText(text);
  const direct = value.match(/^\/schedule(?:@\w+)?\s+([\s\S]+)$/i);
  const body = direct?.[1];
  if (!body?.trim()) return null;
  return { type: "schedule", text: body.trim() };
}

export function parseTaskManagement(text) {
  const value = commandText(text);
  const create = parseTaskCreateRequest(value);
  if (create) return create;
  if (/^\/schedule(?:@\w+)?\s*$/i.test(value)) return { type: "schedule-help" };

  if (/^\/tasks(?:@\w+)?\b/i.test(value)) return { type: "list" };
  if (/^\/new(?:@\w+)?\s*$/i.test(value)) return { type: "new" };

  const confirm = value.match(/^\/confirm(?:@\w+)?(?:\s+(\S+))?$/i);
  if (confirm) return { type: "confirm", id: confirm[1] || null };

  const enable = value.match(/^\/enable(?:@\w+)?(?:\s+(\S+))?$/i);
  if (enable) return { type: "enable", id: enable[1] || null };

  const disable = value.match(/^\/disable(?:@\w+)?(?:\s+(\S+))?$/i);
  if (disable) return { type: "disable", id: disable[1] || null };

  const del = value.match(/^\/delete(?:@\w+)?(?:\s+(\S+))?$/i);
  if (del) return { type: "delete", id: del[1] || null };

  return null;
}

export function telegramPrompt(text) {
  return `${text}\n\n[Telegram constraints: reply concisely. Telegram supports basic formatting; use simple Markdown when it improves readability, and avoid Markdown tables or complex rich text unless necessary.]`;
}

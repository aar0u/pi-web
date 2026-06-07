export function createFileSidebar({ state, api, $, errorMessage, insertPromptText }) {
  return async function loadFiles(path = state.filePath) {
    const box = $("files");
    if (!box || !state.data?.cwd) return;
    box.textContent = "Loading…";
    box.className = "files file-empty";
    try {
      const data = await api(`/api/files?path=${encodeURIComponent(path || ".")}`);
      state.filePath = data.relativePath || ".";
      box.className = "files";
      box.innerHTML = "";
      if (data.parentPath) {
        const up = document.createElement("button");
        up.className = "file-row";
        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = "../";
        up.append(name, document.createElement("span"));
        up.onclick = () => void loadFiles(data.parentPath);
        box.append(up);
      }
      for (const entry of data.entries || []) {
        const row = document.createElement("button");
        row.className = "file-row";
        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = `${entry.isDir ? "▸ " : ""}${entry.name}`;
        name.title = entry.relativePath;
        const mention = document.createElement("span");
        mention.className = "file-mention";
        mention.textContent = "@";
        row.append(name, mention);
        row.onclick = () => entry.isDir ? void loadFiles(entry.path) : insertPromptText(`\`${entry.relativePath}\` `);
        mention.onclick = (ev) => {
          ev.stopPropagation();
          insertPromptText(`\`${entry.relativePath}\` `);
        };
        box.append(row);
      }
      if (!box.childElementCount) {
        box.className = "files file-empty";
        box.textContent = "empty";
      }
    } catch (err) {
      box.className = "files file-empty";
      box.textContent = errorMessage(err);
    }
  };
}

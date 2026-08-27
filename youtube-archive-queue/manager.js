(() => {
  "use strict";

  const ACTIVE_KEY = "youtubeArchiveQueueState";
  const SAVED_KEY = "youtubeArchiveSavedQueues";
  const UPDATE_KEY = "youtubeArchivePendingUpdate";
  const PAGE_SIZE = 100;
  const VERSION_URL = "https://piniki-dev.github.io/youtube-archive-queue/version.json";
  const app = document.getElementById("app");
  const toast = document.getElementById("toast");
  let savedQueues = {};
  let activeState = null;
  let selectedChannel = null;
  let query = "";
  let filter = "all";
  let page = 0;
  let draggedIndex = null;
  const selectedIds = new Set();

  function compareVersions(left, right) {
    const a = String(left).split(".").map(Number);
    const b = String(right).split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] || 0) - (b[index] || 0);
      if (difference) return difference;
    }
    return 0;
  }

  async function checkForUpdate() {
    try {
      const response = await fetch(VERSION_URL, { cache: "no-store" });
      if (!response.ok) return;
      const latest = await response.json();
      const currentVersion = chrome.runtime.getManifest().version;
      if (!latest.version || compareVersions(latest.version, currentVersion) <= 0) return;
      const banner = document.getElementById("update-banner");
      document.getElementById("update-message").textContent = `新しいベータ版 v${latest.version} があります`;
      document.getElementById("update-link").href = latest.releaseUrl || "https://github.com/piniki-dev/youtube-archive-queue/releases/latest";
      document.getElementById("update-dismiss").addEventListener("click", () => { banner.hidden = true; }, { once: true });
      banner.hidden = false;
    } catch (_) {
      // オフライン時やPages公開前は何も表示しない。
    }
  }

  const isExcluded = (item) => item?.excluded === true || Number(item?.pendingDeleteUntil ?? 0) > 0;
  const thumbFor = (item) => item?.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item?.id ?? "")}/mqdefault.jpg`;
  const titleFor = (queue) => queue.channelTitle || queue.channel.replace(/^\//, "") || "名称未取得のチャンネル";

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 2600);
  }

  async function load() {
    const result = await chrome.storage.local.get([SAVED_KEY, ACTIVE_KEY]);
    savedQueues = result[SAVED_KEY] ?? {};
    activeState = result[ACTIVE_KEY] ?? null;
    render();
    void checkForUpdate();
  }

  async function saveQueue(queue, makeActive = false) {
    queue.updatedAt = Date.now();
    savedQueues[queue.channel] = queue;
    const payload = { [SAVED_KEY]: savedQueues };
    if (makeActive) {
      queue.active = true;
      activeState = queue;
      payload[ACTIVE_KEY] = queue;
    } else if (activeState?.channel === queue.channel) {
      activeState = queue;
      payload[ACTIVE_KEY] = queue;
    }
    await chrome.storage.local.set(payload);
  }

  function nextPlayableIndex(queue, preferred = queue.index ?? 0) {
    if (queue.items[preferred] && !isExcluded(queue.items[preferred]) && (queue.skipWatched === false || !queue.items[preferred].watched)) return preferred;
    for (let index = preferred + 1; index < queue.items.length; index += 1) {
      if (!isExcluded(queue.items[index]) && (queue.skipWatched === false || !queue.items[index].watched)) return index;
    }
    for (let index = 0; index < preferred; index += 1) {
      if (!isExcluded(queue.items[index]) && (queue.skipWatched === false || !queue.items[index].watched)) return index;
    }
    return queue.items.findIndex((item) => !isExcluded(item));
  }

  async function resume(queue, preferredIndex = null) {
    const index = preferredIndex ?? nextPlayableIndex(queue);
    if (index < 0 || !queue.items[index]) {
      notify("再生できる動画がありません");
      return;
    }
    queue.index = index;
    await saveQueue(queue, true);
    await chrome.tabs.create({ url: queue.items[index].url });
  }

  function channelStats(queue) {
    const excluded = queue.items.filter(isExcluded).length;
    const watched = queue.items.filter((item) => item.watched && !isExcluded(item)).length;
    return { total: queue.items.length, watched, unwatched: queue.items.length - watched - excluded, excluded };
  }

  function makeButton(label, onClick, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.addEventListener("click", onClick);
    return button;
  }

  function render() {
    app.replaceChildren();
    if (selectedChannel && savedQueues[selectedChannel]) renderDetail(savedQueues[selectedChannel]);
    else {
      selectedChannel = null;
      renderDashboard();
    }
  }

  function renderDashboard() {
    const queues = Object.values(savedQueues).sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    const summary = document.createElement("p");
    summary.className = "summary";
    summary.textContent = `${queues.length}チャンネル・${queues.reduce((sum, queue) => sum + queue.items.length, 0).toLocaleString()}件を保存中`;
    app.append(summary);
    if (!queues.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "保存済みのキューはありません。YouTubeのチャンネルページからキューを作成してください。";
      app.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "channel-grid";
    for (const queue of queues) {
      const stats = channelStats(queue);
      const card = document.createElement("article");
      card.className = "channel-card";
      const head = document.createElement("div");
      head.className = "channel-head";
      const avatar = document.createElement("img");
      avatar.className = "channel-avatar";
      avatar.src = queue.channelThumbnail || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23333'/%3E%3C/svg%3E";
      avatar.alt = "";
      const names = document.createElement("div");
      const heading = document.createElement("h2");
      heading.className = "channel-title";
      heading.textContent = titleFor(queue);
      const id = document.createElement("div");
      id.className = "channel-id";
      id.textContent = queue.channel;
      names.append(heading, id);
      head.append(avatar, names);

      const statsNode = document.createElement("div");
      statsNode.className = "stats";
      for (const [value, label] of [[stats.total, "合計"], [stats.unwatched, "未視聴"], [stats.watched, "視聴済み"], [stats.excluded, "除外"]]) {
        const stat = document.createElement("div");
        stat.className = "stat";
        stat.innerHTML = `<strong>${value.toLocaleString()}</strong><span>${label}</span>`;
        statsNode.append(stat);
      }

      const current = queue.items[Math.min(queue.index ?? 0, queue.items.length - 1)];
      const last = document.createElement("div");
      last.className = "last-item";
      if (current) {
        const image = document.createElement("img");
        image.src = thumbFor(current);
        image.alt = "";
        const text = document.createElement("span");
        text.className = "last-title";
        text.textContent = `${(queue.index ?? 0) + 1} / ${queue.items.length}　${current.title}`;
        last.append(image, text);
      }

      const actions = document.createElement("div");
      actions.className = "card-actions";
      actions.append(
        makeButton("続きから再生", () => resume(queue), "primary"),
        makeButton("キューを開く", () => { selectedChannel = queue.channel; page = 0; render(); }),
        makeButton("新着を取得", () => requestUpdate(queue)),
        makeButton("削除", () => deleteQueue(queue), "danger")
      );
      card.append(head, statsNode, last, actions);
      grid.append(card);
    }
    app.append(grid);
  }

  async function requestUpdate(queue) {
    await chrome.storage.local.set({ [UPDATE_KEY]: { channel: queue.channel, requestedAt: Date.now() } });
    let streamUrl = queue.sourceUrl || "";
    try {
      const parsed = new URL(streamUrl);
      parsed.pathname = `${parsed.pathname.replace(/\/(?:videos|streams|shorts)\/?$/, "")}/streams`;
      parsed.search = "";
      streamUrl = parsed.href;
    } catch {
      const channelPath = String(queue.channel || "").startsWith("/")
        ? queue.channel
        : `/channel/${queue.channel}`;
      streamUrl = `https://www.youtube.com${channelPath}/streams`;
    }
    await chrome.tabs.create({ url: streamUrl });
    notify("YouTubeを開いて新着を取得します");
  }

  async function deleteQueue(queue) {
    if (!window.confirm(`「${titleFor(queue)}」の保存キューを削除しますか？`)) return;
    delete savedQueues[queue.channel];
    await chrome.storage.local.set({ [SAVED_KEY]: savedQueues });
    if (activeState?.channel === queue.channel) {
      await chrome.storage.local.remove(ACTIVE_KEY);
      activeState = null;
    }
    render();
  }

  function renderDetail(queue) {
    const head = document.createElement("div");
    head.className = "detail-head";
    const title = document.createElement("div");
    title.className = "detail-title";
    const avatar = document.createElement("img");
    avatar.src = queue.channelThumbnail || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23333'/%3E%3C/svg%3E";
    avatar.alt = "";
    const heading = document.createElement("h2");
    heading.textContent = titleFor(queue);
    title.append(avatar, heading);
    head.append(title, makeButton("チャンネル一覧へ", () => { selectedChannel = null; selectedIds.clear(); render(); }));

    const toolbar = document.createElement("div");
    toolbar.className = "toolbar";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "タイトルを検索";
    search.value = query;
    const filterSelect = document.createElement("select");
    for (const [value, label] of [["all", "すべて"], ["unwatched", "未視聴"], ["watched", "視聴済み"], ["excluded", "除外"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; filterSelect.append(option);
    }
    filterSelect.value = filter;
    const applySearch = () => { query = search.value; page = 0; render(); };
    search.addEventListener("keydown", (event) => { if (event.key === "Enter") applySearch(); });
    filterSelect.addEventListener("change", () => { filter = filterSelect.value; page = 0; render(); });
    const filterLabel = document.createElement("span");
    filterLabel.className = "group-label";
    filterLabel.textContent = "表示を絞り込む:";
    const orderLabel = document.createElement("span");
    orderLabel.className = "group-label";
    orderLabel.textContent = "再生順:";
    const orderSelect = document.createElement("select");
    orderSelect.setAttribute("aria-label", "再生順");
    for (const [value, label] of [["newest", "新しい順"], ["oldest", "古い順"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      orderSelect.append(option);
    }
    orderSelect.value = queue.sortOrder === "oldest" ? "oldest" : "newest";
    orderSelect.addEventListener("change", () => {
      if (orderSelect.value !== queue.sortOrder) void reverseQueue(queue);
    });
    toolbar.append(
      search,
      makeButton("検索", applySearch),
      filterLabel,
      filterSelect,
      orderLabel,
      orderSelect,
      makeButton("続きから再生", () => resume(queue), "primary"),
      makeButton("新着を取得", () => requestUpdate(queue))
    );

    const bulk = document.createElement("div");
    bulk.className = "bulk-actions";
    const selectedCount = document.createElement("span");
    selectedCount.className = "muted";
    selectedCount.textContent = `${selectedIds.size}件選択`;
    const bulkLabel = document.createElement("span");
    bulkLabel.className = "group-label";
    bulkLabel.textContent = "選択した項目を操作:";
    const watchedButton = makeButton("視聴済みにする", () => bulkEdit(queue, "watched"));
    const unwatchedButton = makeButton("未視聴に戻す", () => bulkEdit(queue, "unwatched"));
    const excludeButton = makeButton("キューから除外", () => bulkEdit(queue, "exclude"));
    const restoreButton = makeButton("除外から復元", () => bulkEdit(queue, "restore"));
    for (const button of [watchedButton, unwatchedButton, excludeButton, restoreButton]) button.disabled = selectedIds.size === 0;
    bulk.append(
      bulkLabel,
      makeButton("表示中を選択", () => toggleVisibleSelection(queue)),
      selectedCount,
      watchedButton,
      unwatchedButton,
      excludeButton,
      restoreButton
    );

    app.append(head, toolbar, bulk);
    renderRows(queue);
  }

  function filteredEntries(queue) {
    const normalized = query.trim().toLocaleLowerCase();
    return queue.items.map((item, index) => ({ item, index })).filter(({ item }) => {
      if (filter === "watched" && (!item.watched || isExcluded(item))) return false;
      if (filter === "unwatched" && (item.watched || isExcluded(item))) return false;
      if (filter === "excluded" && !isExcluded(item)) return false;
      return !normalized || item.title.toLocaleLowerCase().includes(normalized);
    });
  }

  function renderRows(queue) {
    const entries = filteredEntries(queue);
    const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    page = Math.max(0, Math.min(page, pageCount - 1));
    const visible = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const list = document.createElement("div");
    list.className = "queue-list";
    for (const { item, index } of visible) list.append(makeRow(queue, item, index));
    if (!visible.length) {
      const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "条件に一致する動画はありません"; list.append(empty);
    }
    const pager = document.createElement("div");
    pager.className = "pager";
    const prev = makeButton("前の100件", () => { page -= 1; render(); }); prev.disabled = page === 0;
    const next = makeButton("次の100件", () => { page += 1; render(); }); next.disabled = page >= pageCount - 1;
    const status = document.createElement("span"); status.className = "muted"; status.textContent = `${entries.length.toLocaleString()}件・${page + 1} / ${pageCount}ページ`;
    pager.append(prev, status, next);
    app.append(list, pager);
  }

  function makeRow(queue, item, index) {
    const row = document.createElement("div");
    row.className = "queue-row";
    row.dataset.index = String(index);
    if (index === queue.index) row.classList.add("current");
    if (item.watched) row.classList.add("watched");
    if (isExcluded(item)) row.classList.add("excluded");
    const handle = document.createElement("span"); handle.className = "drag-handle"; handle.textContent = "⠿"; handle.draggable = !isExcluded(item);
    handle.addEventListener("dragstart", (event) => { draggedIndex = index; event.dataTransfer.setData("text/plain", String(index)); });
    handle.addEventListener("dragend", () => { draggedIndex = null; for (const target of document.querySelectorAll(".drag-over")) target.classList.remove("drag-over"); });
    row.addEventListener("dragover", (event) => { if (draggedIndex !== null && draggedIndex !== index) { event.preventDefault(); row.classList.add("drag-over"); } });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", async (event) => { event.preventDefault(); row.classList.remove("drag-over"); if (draggedIndex !== null) await moveItem(queue, draggedIndex, index); draggedIndex = null; });
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = selectedIds.has(item.id); check.addEventListener("change", () => { if (check.checked) selectedIds.add(item.id); else selectedIds.delete(item.id); render(); });
    const number = document.createElement("span"); number.className = "queue-number"; number.textContent = String(index + 1);
    const wrap = document.createElement("span"); wrap.className = "thumb-wrap";
    const image = document.createElement("img"); image.className = "thumb"; image.src = thumbFor(item); image.alt = ""; image.loading = "lazy";
    const progress = document.createElement("span"); progress.className = "progress"; progress.style.width = `${item.watched ? 100 : item.durationSeconds ? Math.min(100, (item.progressSeconds ?? 0) / item.durationSeconds * 100) : 0}%`; wrap.append(image, progress);
    const info = document.createElement("div"); info.className = "queue-info";
    const itemTitle = makeButton(item.title, () => resume(queue, index)); itemTitle.className = "queue-title"; itemTitle.disabled = isExcluded(item);
    const meta = document.createElement("div"); meta.className = "queue-meta";
    const date = item.publishedAt ? new Date(item.publishedAt).toLocaleDateString("ja-JP") : item.publishedText;
    meta.textContent = `${isExcluded(item) ? "除外" : item.unavailable ? "再生不能" : item.watched ? "視聴済み" : "未視聴"}${item.progressSeconds ? `・${Math.floor(item.progressSeconds / 60)}分まで` : ""}${date ? `・${date}` : ""}`;
    info.append(itemTitle, meta);
    const actions = document.createElement("div"); actions.className = "row-actions";
    actions.append(
      makeButton(item.watched ? "未視聴に戻す" : "視聴済み", () => editItem(queue, index, "watched")),
      makeButton("ここまで視聴済み", () => editItem(queue, index, "through")),
      isExcluded(item) ? makeButton("復元", () => editItem(queue, index, "restore")) : makeButton("除外", () => editItem(queue, index, "exclude"))
    );
    row.append(handle, check, number, wrap, info, actions);
    return row;
  }

  async function moveItem(queue, from, to) {
    if (from === to) return;
    const currentId = queue.items[queue.index]?.id;
    const [item] = queue.items.splice(from, 1); queue.items.splice(to, 0, item);
    queue.index = queue.items.findIndex((candidate) => candidate.id === currentId);
    await saveQueue(queue); render();
  }

  async function editItem(queue, index, action) {
    const item = queue.items[index];
    if (action === "watched") item.watched = !item.watched;
    if (action === "through") for (let cursor = 0; cursor <= index; cursor += 1) queue.items[cursor].watched = true;
    if (action === "exclude") item.excluded = true;
    if (action === "restore") { item.excluded = false; delete item.pendingDeleteUntil; }
    await saveQueue(queue); render();
  }

  async function reverseQueue(queue) {
    const currentId = queue.items[queue.index]?.id;
    queue.items.reverse();
    queue.index = queue.items.findIndex((item) => item.id === currentId);
    queue.sortOrder = queue.sortOrder === "oldest" ? "newest" : "oldest";
    await saveQueue(queue);
    page = Math.floor(queue.index / PAGE_SIZE);
    render();
  }

  function visibleIds(queue) {
    return filteredEntries(queue).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ item }) => item.id);
  }

  function toggleVisibleSelection(queue) {
    const ids = visibleIds(queue); const select = ids.some((id) => !selectedIds.has(id));
    for (const id of ids) select ? selectedIds.add(id) : selectedIds.delete(id);
    render();
  }

  async function bulkEdit(queue, action) {
    for (const item of queue.items) {
      if (!selectedIds.has(item.id)) continue;
      if (action === "watched") item.watched = true;
      if (action === "unwatched") item.watched = false;
      if (action === "exclude") item.excluded = true;
      if (action === "restore") { item.excluded = false; delete item.pendingDeleteUntil; }
    }
    selectedIds.clear(); await saveQueue(queue); render();
  }

  async function exportQueues() {
    const payload = { format: "youtube-archive-queue-backup", version: 1, exportedAt: new Date().toISOString(), queues: savedQueues };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `youtube-archive-queue-${new Date().toISOString().slice(0, 10)}.json`; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importQueues(file) {
    try {
      const payload = JSON.parse(await file.text());
      if (payload?.format !== "youtube-archive-queue-backup" || !payload.queues) throw new Error("対応するバックアップではありません");
      savedQueues = { ...savedQueues, ...payload.queues };
      await chrome.storage.local.set({ [SAVED_KEY]: savedQueues });
      notify(`${Object.keys(payload.queues).length}件のキューを復元しました`); render();
    } catch (error) { notify(error instanceof Error ? error.message : "復元に失敗しました"); }
  }

  document.getElementById("export-button").addEventListener("click", exportQueues);
  const importFile = document.getElementById("import-file");
  document.getElementById("import-button").addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => { if (importFile.files?.[0]) await importQueues(importFile.files[0]); importFile.value = ""; });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[SAVED_KEY]) savedQueues = changes[SAVED_KEY].newValue ?? {};
    if (changes[ACTIVE_KEY]) activeState = changes[ACTIVE_KEY].newValue ?? null;
    if (changes[SAVED_KEY] || changes[ACTIVE_KEY]) render();
  });
  void load();
})();

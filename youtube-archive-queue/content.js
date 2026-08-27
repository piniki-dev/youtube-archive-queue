(() => {
  "use strict";

  const STORAGE_KEY = "youtubeArchiveQueueState";
  const SAVED_QUEUES_KEY = "youtubeArchiveSavedQueues";
  const UPDATE_REQUEST_KEY = "youtubeArchivePendingUpdate";
  const PANEL_ID = "yaq-panel";
  const MAX_ITEMS = 10000;
  const SCROLL_DELAY_MS = 850;
  const STABLE_ROUNDS_TO_FINISH = 4;
  const QUEUE_PAGE_SIZE = 100;
  const PROGRESS_SAVE_INTERVAL_MS = 5000;

  let lastUrl = location.href;
  let scanCancelled = false;
  let attachedVideo = null;
  let queuePage = null;
  let queueQuery = "";
  let queueFilter = "all";
  let progressTimer = null;
  let resumedVideoId = null;
  let draggedItemIndex = null;
  const selectedItemIds = new Set();
  const skippedErrorIds = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ICONS = {
    previous: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zm3 7 10-7v14z"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 10 7-10 7zm11 0h2v14h-2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zm6 0h4v14h-4z"/></svg>',
    list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zM4 16h2v2H4zm4 0h12v2H8z"/></svg>',
    minimize: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z"/></svg>'
  };

  function videoIdFromUrl(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const match = url.pathname.match(/^\/shorts\/([\w-]{6,})/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  function isChannelListPage() {
    return /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/(?:videos|streams|shorts)\/?$/.test(
      location.pathname
    );
  }

  function channelIdentity() {
    const externalId = document.querySelector('meta[itemprop="channelId"]')?.content;
    if (externalId) return externalId;
    const match = location.pathname.match(/^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/);
    return match?.[0] ?? location.pathname;
  }

  function channelMetadata() {
    return {
      title:
        document.querySelector('meta[property="og:title"]')?.content ||
        document.querySelector("#channel-header-container #text")?.textContent?.trim() ||
        channelIdentity(),
      thumbnail:
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector("#channel-header-container img")?.src ||
        null
    };
  }

  function isUpcomingItem(anchor) {
    const card = anchor.closest(
      "ytd-rich-item-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytd-video-renderer"
    );
    if (!card) return false;

    if (
      card.querySelector(
        '[overlay-style="UPCOMING"], [data-style="UPCOMING"], [aria-label*="Set reminder" i], [aria-label*="通知を受け取る"]'
      )
    ) {
      return true;
    }

    const badgeText = [...card.querySelectorAll("ytd-badge-supported-renderer, yt-badge-shape, .badge")]
      .map((node) => node.textContent?.trim() ?? "")
      .join(" ");
    const stateText = `${badgeText} ${card.innerText ?? ""}`;
    return /\bupcoming\b|scheduled for|premieres?\b|待機中|配信予定|公開予定|後に配信|後に公開/i.test(
      stateText
    );
  }

  function collectVisibleItems(existing = new Map()) {
    const selectors = [
      "ytd-rich-grid-renderer ytd-rich-item-renderer a#video-title-link",
      "ytd-rich-grid-renderer ytd-rich-item-renderer a#video-title",
      "ytd-grid-video-renderer a#video-title",
      "ytd-rich-grid-renderer ytd-rich-item-renderer a[href^='/shorts/']",
      "ytd-rich-grid-renderer a[href^='/watch?v=']",
      "ytd-rich-grid-renderer a[href^='/shorts/']"
    ];

    for (const anchor of document.querySelectorAll(selectors.join(","))) {
      if (isUpcomingItem(anchor)) continue;
      const id = videoIdFromUrl(anchor.href);
      if (!id || existing.has(id)) continue;
      const card = anchor.closest(
        "ytd-rich-item-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytd-video-renderer"
      );
      const titleAnchor =
        card?.querySelector("a.ytLockupMetadataViewModelTitle") ||
        card?.querySelector("a#video-title-link") ||
        card?.querySelector("a#video-title");
      const title =
        titleAnchor?.getAttribute("title")?.trim() ||
        titleAnchor?.textContent?.trim() ||
        anchor.getAttribute("aria-label")?.trim() ||
        anchor.getAttribute("title")?.trim() ||
        `YouTube video ${id}`;
      const thumbnailNode = card?.querySelector("img");
      const thumbnail =
        thumbnailNode?.currentSrc ||
        thumbnailNode?.src ||
        thumbnailNode?.getAttribute("data-thumb") ||
        `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
      const publishedText = (card?.innerText ?? "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => /配信済み|公開済み|\d+\s*(?:秒|分|時間|日|週間|か月|ヶ月|年)前|streamed|premiered|ago/i.test(line));
      existing.set(id, {
        id,
        title,
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`,
        thumbnail,
        watched: false,
        progressSeconds: 0,
        publishedText: publishedText ?? null,
        publishedAt: null
      });
      if (existing.size >= MAX_ITEMS) break;
    }
    return existing;
  }

  async function getState() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY] ?? null;
  }

  async function getSavedQueue(channel) {
    const result = await chrome.storage.local.get(SAVED_QUEUES_KEY);
    return result[SAVED_QUEUES_KEY]?.[channel] ?? null;
  }

  async function setState(state) {
    const result = await chrome.storage.local.get(SAVED_QUEUES_KEY);
    const savedQueues = result[SAVED_QUEUES_KEY] ?? {};
    if (state?.channel) savedQueues[state.channel] = state;
    await chrome.storage.local.set({ [STORAGE_KEY]: state, [SAVED_QUEUES_KEY]: savedQueues });
  }

  async function setSavedQueueOnly(state) {
    const result = await chrome.storage.local.get([SAVED_QUEUES_KEY, STORAGE_KEY]);
    const savedQueues = result[SAVED_QUEUES_KEY] ?? {};
    savedQueues[state.channel] = state;
    const payload = { [SAVED_QUEUES_KEY]: savedQueues };
    if (result[STORAGE_KEY]?.channel === state.channel) payload[STORAGE_KEY] = state;
    await chrome.storage.local.set(payload);
  }

  async function clearState() {
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  async function deleteSavedQueue(channel) {
    const result = await chrome.storage.local.get(SAVED_QUEUES_KEY);
    const savedQueues = result[SAVED_QUEUES_KEY] ?? {};
    delete savedQueues[channel];
    await chrome.storage.local.set({ [SAVED_QUEUES_KEY]: savedQueues });
    await clearState();
  }

  function createPanel(kind) {
    document.getElementById(PANEL_ID)?.remove();
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.dataset.kind = kind;
    panel.setAttribute("aria-live", "polite");
    document.body.append(panel);
    return panel;
  }

  function updateFullscreenState() {
    const youtubeFullscreen = Boolean(document.querySelector("ytd-watch-flexy[fullscreen]"));
    document.documentElement.classList.toggle(
      "yaq-video-fullscreen",
      Boolean(document.fullscreenElement) || youtubeFullscreen
    );
  }

  async function scanAllItems(statusNode) {
    scanCancelled = false;
    const originalScrollY = window.scrollY;
    const items = new Map();
    let stableRounds = 0;
    let previousSize = -1;
    let previousHeight = -1;

    while (!scanCancelled && items.size < MAX_ITEMS) {
      collectVisibleItems(items);
      statusNode.textContent = `${items.size.toLocaleString()}件を読み込み中…`;

      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const atBottom = window.scrollY + window.innerHeight >= height - 8;
      if (items.size === previousSize && height === previousHeight && atBottom) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      if (stableRounds >= STABLE_ROUNDS_TO_FINISH) break;

      previousSize = items.size;
      previousHeight = height;
      window.scrollTo({ top: height, behavior: "auto" });
      await sleep(SCROLL_DELAY_MS);
    }

    window.scrollTo({ top: originalScrollY, behavior: "auto" });
    return [...items.values()];
  }

  function detectPageOrder() {
    const sortControl = [...document.querySelectorAll('button[role="combobox"]')].find((node) =>
      /新しい順|古い順|newest|oldest/i.test(node.textContent ?? "")
    );
    const selected = sortControl ?? [...document.querySelectorAll("button, yt-chip-cloud-chip-renderer")].find((node) => {
      const selectedState =
        node.getAttribute("aria-pressed") === "true" ||
        node.hasAttribute("selected") ||
        node.getAttribute("aria-selected") === "true";
      return selectedState && /新しい順|古い順|newest|oldest/i.test(node.textContent ?? "");
    });
    if (/古い順|oldest/i.test(selected?.textContent ?? "")) return "oldest";
    return "newest";
  }

  async function scanNewItems(statusNode, knownIds) {
    scanCancelled = false;
    const originalScrollY = window.scrollY;
    const found = new Map();
    let reachedKnown = false;
    let roundsAfterKnown = 0;

    while (!scanCancelled && found.size < MAX_ITEMS) {
      const pageItems = collectVisibleItems(new Map());
      for (const [id, item] of pageItems) {
        if (knownIds.has(id)) reachedKnown = true;
        else if (!reachedKnown) found.set(id, item);
      }
      statusNode.textContent = `${found.size.toLocaleString()}件の新着を確認中…`;
      if (reachedKnown) {
        roundsAfterKnown += 1;
        if (roundsAfterKnown >= 2) break;
      }
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      window.scrollTo({ top: height, behavior: "auto" });
      await sleep(SCROLL_DELAY_MS);
    }
    window.scrollTo({ top: originalScrollY, behavior: "auto" });
    return [...found.values()];
  }

  async function startQueue(items, sortOrder) {
    if (!items.length) throw new Error("動画を取得できませんでした。ページを再読み込みしてお試しください。");
    const metadata = channelMetadata();
    const state = {
      items,
      index: 0,
      channel: channelIdentity(),
      channelTitle: metadata.title,
      channelThumbnail: metadata.thumbnail,
      sourceUrl: location.href,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sortOrder,
      skipWatched: true,
      active: true
    };
    await setState(state);
    location.assign(items[0].url);
  }

  async function renderListPanel() {
    const channel = channelIdentity();
    const activeState = await getState();
    const saved = (await getSavedQueue(channel)) ?? (activeState?.channel === channel ? activeState : null);
    const hasSavedQueue = Array.isArray(saved?.items) && saved.items.length > 0;
    if (hasSavedQueue && (!saved.channelTitle || !saved.channelThumbnail)) {
      const metadata = channelMetadata();
      saved.channelTitle ||= metadata.title;
      saved.channelThumbnail ||= metadata.thumbnail;
      saved.sourceUrl ||= location.href;
      await setSavedQueueOnly(saved);
    }
    const panel = createPanel("list");
    panel.innerHTML = `
      <div class="yaq-title">Archive Queue</div>
      <div class="yaq-status">${hasSavedQueue ? `保存済み：${saved.items.length.toLocaleString()}件` : "チャンネルの動画をキューに取り込みます"}</div>
      <label class="yaq-field">
        <span>再生順</span>
        <select class="yaq-order">
          <option value="newest">新しい順</option>
          <option value="oldest">古い順</option>
        </select>
      </label>
      <div class="yaq-actions">
        ${hasSavedQueue ? '<button type="button" class="yaq-primary" data-action="resume">続きから再生</button><button type="button" data-action="update">新着を更新</button>' : ""}
        <button type="button" data-action="rebuild">${hasSavedQueue ? "全件を再取得" : "キューを作成して再生"}</button>
        <button type="button" data-action="manager">管理ページ</button>
      </div>
    `;

    const status = panel.querySelector(".yaq-status");
    const actions = panel.querySelector(".yaq-actions");
    const startButton = panel.querySelector('[data-action="rebuild"]');
    const orderSelect = panel.querySelector(".yaq-order");
    panel.querySelector('[data-action="manager"]').addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "open-manager" });
    });
    orderSelect.value = hasSavedQueue ? saved.sortOrder ?? "newest" : detectPageOrder();

    panel.querySelector('[data-action="resume"]')?.addEventListener("click", async () => {
      saved.active = true;
      await setState(saved);
      location.assign(saved.items[Math.min(saved.index ?? 0, saved.items.length - 1)].url);
    });

    panel.querySelector('[data-action="update"]')?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const newItems = await scanNewItems(status, new Set(saved.items.map((item) => item.id)));
        if (newItems.length) {
          if ((saved.sortOrder ?? "newest") === "oldest") saved.items.push(...newItems.reverse());
          else {
            saved.items.unshift(...newItems);
            saved.index = (saved.index ?? 0) + newItems.length;
          }
          saved.updatedAt = Date.now();
          await setSavedQueueOnly(saved);
        }
        status.textContent = newItems.length
          ? `${newItems.length.toLocaleString()}件を追加しました`
          : "新しい動画はありません";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "更新に失敗しました";
      } finally {
        button.disabled = false;
      }
    });

    const updateRequest = (await chrome.storage.local.get(UPDATE_REQUEST_KEY))[UPDATE_REQUEST_KEY];
    if (hasSavedQueue && updateRequest?.channel === channel) {
      await chrome.storage.local.remove(UPDATE_REQUEST_KEY);
      panel.querySelector('[data-action="update"]')?.click();
    }

    startButton.addEventListener("click", async () => {
      startButton.disabled = true;
      const cancelButton = document.createElement("button");
      cancelButton.type = "button";
      cancelButton.textContent = "中止";
      cancelButton.addEventListener("click", () => {
        scanCancelled = true;
        cancelButton.disabled = true;
        status.textContent = "読み込みを中止しています…";
      });
      actions.append(cancelButton);

      try {
        let items = await scanAllItems(status);
        if (scanCancelled) {
          status.textContent = `${items.length.toLocaleString()}件で中止しました`;
          startButton.disabled = false;
          cancelButton.remove();
          return;
        }
        const pageOrder = detectPageOrder();
        if (orderSelect.value !== pageOrder) items = items.reverse();
        status.textContent = `${items.length.toLocaleString()}件を再生します`;
        await startQueue(items, orderSelect.value);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "エラーが発生しました";
        startButton.disabled = false;
        cancelButton.remove();
      }
    });
  }

  async function goToQueueIndex(index) {
    const state = await getState();
    if (!state?.active || !state.items?.[index]) return;
    state.index = index;
    await setState(state);
    location.assign(state.items[index].url);
  }

  async function syncCurrentVideo() {
    const currentId = videoIdFromUrl(location.href);
    const state = await getState();
    if (!currentId || !state?.active || !Array.isArray(state.items)) return null;

    const actualIndex = state.items.findIndex((item) => item.id === currentId);
    if (actualIndex < 0) return null;
    if (actualIndex !== state.index) {
      state.index = actualIndex;
      await setState(state);
    }
    return state;
  }

  async function updateQueue(action, itemIndex, targetIndex = null) {
    const state = await getState();
    if (!state?.active || !Array.isArray(state.items)) return;
    const currentId = state.items[state.index]?.id;
    let navigateTo = null;

    if (action === "remove") {
      state.items[itemIndex].excluded = true;
      delete state.items[itemIndex].pendingDeleteUntil;
      selectedItemIds.delete(state.items[itemIndex].id);
      if (state.items[itemIndex]?.id === currentId) {
        const replacement = replacementQueueIndex(state, itemIndex);
        if (replacement >= 0) {
          state.index = replacement;
          navigateTo = state.items[replacement].url;
        }
      }
    }

    if (action === "restore-delete") {
      state.items[itemIndex].excluded = false;
      delete state.items[itemIndex].pendingDeleteUntil;
    }

    if (action === "move" && targetIndex !== null && itemIndex !== targetIndex) {
      const [movedItem] = state.items.splice(itemIndex, 1);
      state.items.splice(targetIndex, 0, movedItem);
      state.index = state.items.findIndex((item) => item.id === currentId);
    }

    if (action === "reverse") {
      state.items.reverse();
      state.index = state.items.findIndex((item) => item.id === currentId);
      state.sortOrder = state.sortOrder === "oldest" ? "newest" : "oldest";
      queuePage = Math.floor(state.index / QUEUE_PAGE_SIZE);
    }

    if (action === "toggle-watched") {
      state.items[itemIndex].watched = !state.items[itemIndex].watched;
      if (!state.items[itemIndex].watched) state.items[itemIndex].unavailable = false;
    }

    if (action === "watched-through") {
      for (let index = 0; index <= itemIndex; index += 1) state.items[index].watched = true;
    }

    await setState(state);
    if (navigateTo) {
      location.assign(navigateTo);
    } else {
      await renderPlayerPanel(true);
    }
  }

  function isPendingDelete(item) {
    return item?.excluded === true || Number(item?.pendingDeleteUntil ?? 0) > 0;
  }

  function replacementQueueIndex(state, fromIndex) {
    for (let index = fromIndex + 1; index < state.items.length; index += 1) {
      if (!isPendingDelete(state.items[index]) && (state.skipWatched === false || !state.items[index].watched)) return index;
    }
    for (let index = fromIndex - 1; index >= 0; index -= 1) {
      if (!isPendingDelete(state.items[index]) && (state.skipWatched === false || !state.items[index].watched)) return index;
    }
    return -1;
  }

  async function applyBulkAction(action) {
    const state = await getState();
    if (!state?.active || !selectedItemIds.size) return;
    const currentId = state.items[state.index]?.id;

    if (action === "remove") {
      for (const item of state.items) {
        if (selectedItemIds.has(item.id)) {
          item.excluded = true;
          delete item.pendingDeleteUntil;
        }
      }
      if (selectedItemIds.has(currentId)) {
        const replacement = replacementQueueIndex(state, state.index);
        if (replacement >= 0) state.index = replacement;
      }
    } else {
      const watched = action === "watched";
      for (const item of state.items) {
        if (selectedItemIds.has(item.id)) item.watched = watched;
      }
    }
    selectedItemIds.clear();
    await setState(state);
    if (
      isPendingDelete(state.items.find((item) => item.id === videoIdFromUrl(location.href))) &&
      state.active &&
      !isPendingDelete(state.items[state.index])
    ) {
      location.assign(state.items[state.index].url);
    } else {
      await renderPlayerPanel(true);
    }
  }

  function nextQueueIndex(state, fromIndex) {
    for (let index = fromIndex + 1; index < state.items.length; index += 1) {
      if (!isPendingDelete(state.items[index]) && (state.skipWatched === false || !state.items[index].watched)) return index;
    }
    return state.items.length;
  }

  async function goToNextVideo() {
    const state = await getState();
    if (!state?.active) return;
    const nextIndex = nextQueueIndex(state, state.index);
    if (nextIndex < state.items.length) await goToQueueIndex(nextIndex);
  }

  function renderQueueList(panel, state) {
    const list = panel.querySelector(".yaq-queue-list");
    const normalizedQuery = queueQuery.trim().toLocaleLowerCase();
    const filteredItems = state.items
      .map((item, itemIndex) => ({ item, itemIndex }))
      .filter(({ item }) => {
        if (queueFilter === "watched" && !item.watched) return false;
        if (queueFilter === "unwatched" && item.watched) return false;
        return !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery);
      });
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / QUEUE_PAGE_SIZE));
    if (queuePage === null) queuePage = Math.floor(state.index / QUEUE_PAGE_SIZE);
    queuePage = Math.max(0, Math.min(queuePage, pageCount - 1));
    const start = queuePage * QUEUE_PAGE_SIZE;
    const pageItems = filteredItems.slice(start, start + QUEUE_PAGE_SIZE);

    for (const { item, itemIndex } of pageItems) {
      const row = document.createElement("div");
      row.className = "yaq-queue-item";
      row.dataset.itemIndex = String(itemIndex);
      row.dataset.itemId = item.id;
      if (itemIndex === state.index) row.classList.add("is-current");
      if (item.watched) row.classList.add("is-watched");
      if (isPendingDelete(item)) row.classList.add("is-pending-delete");

      const number = document.createElement("span");
      number.className = "yaq-item-number";
      number.textContent = String(itemIndex + 1);

      const selection = document.createElement("input");
      selection.type = "checkbox";
      selection.className = "yaq-item-select";
      selection.checked = selectedItemIds.has(item.id);
      selection.disabled = isPendingDelete(item);
      selection.setAttribute("aria-label", `${item.title}を選択`);
      selection.addEventListener("change", () => {
        if (selection.checked) selectedItemIds.add(item.id);
        else selectedItemIds.delete(item.id);
        const count = panel.querySelector(".yaq-selected-count");
        if (count) count.textContent = `${selectedItemIds.size}件選択`;
        for (const button of panel.querySelectorAll("[data-bulk]")) button.disabled = selectedItemIds.size === 0;
      });

      const thumbnail = document.createElement("img");
      thumbnail.className = "yaq-thumbnail";
      thumbnail.src = item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/mqdefault.jpg`;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      const thumbnailWrap = document.createElement("span");
      thumbnailWrap.className = "yaq-thumbnail-wrap";
      const progress = document.createElement("span");
      progress.className = "yaq-progress-bar";
      const duration = Number(item.durationSeconds ?? 0);
      const progressPercent = item.watched ? 100 : duration > 0 ? Math.min(100, ((item.progressSeconds ?? 0) / duration) * 100) : 0;
      progress.style.width = `${progressPercent}%`;
      thumbnailWrap.append(thumbnail, progress);

      const dragHandle = document.createElement("span");
      dragHandle.className = "yaq-drag-handle";
      dragHandle.textContent = "⠿";
      dragHandle.title = "ドラッグして並べ替え";
      dragHandle.setAttribute("aria-label", `${item.title}をドラッグして並べ替え`);
      dragHandle.draggable = true;
      if (isPendingDelete(item)) dragHandle.draggable = false;
      dragHandle.addEventListener("dragstart", (event) => {
        draggedItemIndex = itemIndex;
        row.classList.add("is-dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(itemIndex));
      });
      dragHandle.addEventListener("dragend", () => {
        draggedItemIndex = null;
        row.classList.remove("is-dragging");
        for (const target of list.querySelectorAll(".is-drag-over")) target.classList.remove("is-drag-over");
      });
      row.addEventListener("dragover", (event) => {
        if (draggedItemIndex === null || draggedItemIndex === itemIndex) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("is-drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
      row.addEventListener("drop", async (event) => {
        event.preventDefault();
        row.classList.remove("is-drag-over");
        if (draggedItemIndex !== null) {
          const fromIndex = draggedItemIndex;
          await animateQueueMove(list, fromIndex, itemIndex);
          await updateQueue("move", fromIndex, itemIndex);
        }
      });

      const title = document.createElement("button");
      title.type = "button";
      title.className = "yaq-item-title";
      title.textContent = item.title;
      title.title = item.title;
      title.disabled = isPendingDelete(item);
      title.addEventListener("click", () => goToQueueIndex(itemIndex));

      const meta = document.createElement("span");
      meta.className = "yaq-item-meta";
      const seconds = Math.floor(item.progressSeconds ?? 0);
      const dateLabel = item.publishedAt
        ? new Date(item.publishedAt).toLocaleDateString("ja-JP")
        : item.publishedText;
      meta.textContent = `${isPendingDelete(item) ? "キューから除外・復元可能" : item.unavailable ? "再生不能・自動スキップ" : item.watched ? "視聴済み" : "未視聴"}${seconds > 0 ? `・${Math.floor(seconds / 60)}分${seconds % 60}秒まで` : ""}${dateLabel ? `・${dateLabel}` : ""}`;

      const info = document.createElement("span");
      info.className = "yaq-item-info";
      info.append(title, meta);

      const controls = document.createElement("span");
      controls.className = "yaq-item-controls";
      const availableActions = isPendingDelete(item) ? [
        ["restore-delete", "元に戻す", "削除を取り消す"]
      ] : [
        ["toggle-watched", item.watched ? "未視聴に戻す" : "視聴済み", item.watched ? "未視聴に戻す" : "視聴済みにする"],
        ["watched-through", "ここまで視聴済み", "ここまでを視聴済みにする"],
        ["remove", "×", "削除"]
      ];
      for (const [action, label, description] of availableActions) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = action;
        button.textContent = label;
        button.setAttribute("aria-label", `${item.title}を${description}`);
        button.addEventListener("click", () => updateQueue(action, itemIndex));
        controls.append(button);
      }
      row.append(dragHandle, selection, number, thumbnailWrap, info, controls);
      list.append(row);
    }

    if (!pageItems.length) {
      const empty = document.createElement("div");
      empty.className = "yaq-empty";
      empty.textContent = "条件に一致する動画はありません";
      list.append(empty);
    }

    const pager = panel.querySelector(".yaq-pager");
    pager.querySelector(".yaq-page-status").textContent = `${filteredItems.length.toLocaleString()}件・${queuePage + 1} / ${pageCount}ページ`;
    pager.querySelector('[data-page="prev"]').disabled = queuePage === 0;
    pager.querySelector('[data-page="next"]').disabled = queuePage >= pageCount - 1;
  }

  async function animateQueueMove(list, fromIndex, toIndex) {
    if (fromIndex === toIndex || typeof Element.prototype.animate !== "function") return;
    const source = list.querySelector(`[data-item-index="${fromIndex}"]`);
    const target = list.querySelector(`[data-item-index="${toIndex}"]`);
    if (!source || !target) return;

    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const sourceDistance = targetRect.top - sourceRect.top;
    const options = { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" };
    const animations = [source.animate(
      [{ transform: "translateY(0)", opacity: 0.45 }, { transform: `translateY(${sourceDistance}px)`, opacity: 0.8 }],
      options
    )];
    const rangeStart = Math.min(fromIndex, toIndex);
    const rangeEnd = Math.max(fromIndex, toIndex);
    const rowStep = Math.abs(sourceDistance / (toIndex - fromIndex)) || sourceRect.height;
    const siblingDistance = rowStep * (fromIndex < toIndex ? -1 : 1);
    for (const sibling of list.querySelectorAll(".yaq-queue-item")) {
      const siblingIndex = Number(sibling.dataset.itemIndex);
      if (siblingIndex < rangeStart || siblingIndex > rangeEnd || siblingIndex === fromIndex) continue;
      animations.push(
        sibling.animate(
          [{ transform: "translateY(0)" }, { transform: `translateY(${siblingDistance}px)` }],
          options
        )
      );
    }
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  }

  function closeQueueManager(panel) {
    const queue = panel.querySelector(".yaq-queue");
    if (!queue?.classList.contains("is-open")) return;
    queue.classList.add("is-closing");
    window.setTimeout(() => {
      queue.classList.remove("is-open", "is-closing");
      panel.dataset.expanded = "false";
    }, 160);
  }

  function minimizePlayerPanel(panel, state) {
    panel.dataset.kind = "player-minimized";
    panel.dataset.expanded = "false";
    panel.classList.add("is-minimized");
    panel.innerHTML = `<button type="button" class="yaq-restore" aria-label="Archive Queueを開く">▶ ${state.index + 1} / ${state.items.length}</button>`;
    panel.querySelector(".yaq-restore").addEventListener("click", async () => {
      if (!state.active) {
        state.active = true;
        await setState(state);
      }
      await renderPlayerPanel(false);
    });
  }

  async function stopContinuousPlayback(panel, state) {
    state.active = false;
    await setState(state);
    await clearState();
    panel.dataset.kind = "inactive";
    panel.dataset.expanded = "false";
    panel.classList.remove("is-minimized");
    panel.innerHTML = `
      <div class="yaq-title">Archive Queue</div>
      <div class="yaq-status">連続再生を停止しました</div>
      <div class="yaq-actions">
        <button type="button" class="yaq-primary" data-action="resume-stopped">再開</button>
        <button type="button" data-action="dismiss">最小化</button>
      </div>
    `;
    panel.querySelector('[data-action="resume-stopped"]').addEventListener("click", async () => {
      state.active = true;
      await setState(state);
      await renderPlayerPanel(false);
    });
    panel.querySelector('[data-action="dismiss"]').addEventListener("click", () => minimizePlayerPanel(panel, state));
  }

  function renderAddToQueuePanel(state) {
    const panel = createPanel("add-to-queue");
    panel.innerHTML = `
      <div class="yaq-title">Archive Queue</div>
      <div class="yaq-status">この動画は現在のキューに含まれていません</div>
      <div class="yaq-actions">
        <button type="button" class="yaq-primary" data-action="back-to-queue">キューに戻る</button>
        <button type="button" data-action="close-external">閉じる</button>
      </div>
    `;
    panel.querySelector('[data-action="back-to-queue"]').addEventListener("click", () => {
      location.assign(state.items[state.index].url);
    });
    panel.querySelector('[data-action="close-external"]').addEventListener("click", () => panel.remove());
  }

  async function renderPlayerPanel(keepListOpen = false) {
    const state = await syncCurrentVideo();
    if (!state) {
      const activeState = await getState();
      const currentId = videoIdFromUrl(location.href);
      if (activeState?.active && currentId && !activeState.items.some((item) => item.id === currentId)) {
        renderAddToQueuePanel(activeState);
      } else {
        document.getElementById(PANEL_ID)?.remove();
      }
      return;
    }
    const panel = createPanel("player");
    const current = state.items[state.index];
    panel.innerHTML = `
      <div class="yaq-player-head">
        <div class="yaq-player-info">
          <div class="yaq-title">Archive Queue</div>
          <div class="yaq-status"></div>
        </div>
        <div class="yaq-player-controls">
          <button type="button" class="yaq-icon-button" data-action="prev" aria-label="前の動画" title="前の動画">${ICONS.previous}</button>
          <button type="button" class="yaq-icon-button" data-action="toggle-play" aria-label="再生" title="再生">${ICONS.play}</button>
          <button type="button" class="yaq-icon-button" data-action="next" aria-label="次の動画" title="次の動画">${ICONS.next}</button>
          <button type="button" class="yaq-icon-button" data-action="toggle-list" aria-label="再生キューを開く" title="再生キューを開く">${ICONS.list}</button>
          <button type="button" class="yaq-icon-button" data-action="minimize" aria-label="最小化" title="最小化">${ICONS.minimize}</button>
        </div>
      </div>
      <div class="yaq-current"></div>
      <div class="yaq-queue${keepListOpen ? " is-open" : ""}">
        <div class="yaq-queue-toolbar">
          <span class="yaq-queue-heading">
            <strong>再生キュー</strong>
            <select class="yaq-queue-order" aria-label="再生順">
              <option value="newest">新しい順</option>
              <option value="oldest">古い順</option>
            </select>
          </span>
          <span class="yaq-toolbar-actions">
            <button type="button" data-action="manager">管理ページ</button>
            <button type="button" data-action="stop">連続再生を停止</button>
            <button type="button" data-action="close-list">閉じる</button>
          </span>
        </div>
        <div class="yaq-queue-filters">
          <input type="search" class="yaq-search" placeholder="タイトルを検索" value="">
          <button type="button" data-action="search">検索</button>
          <span class="yaq-group-label">表示を絞り込む:</span>
          <select class="yaq-watch-filter" aria-label="視聴状態">
            <option value="all">すべて</option>
            <option value="unwatched">未視聴</option>
            <option value="watched">視聴済み</option>
          </select>
          <label class="yaq-check"><input type="checkbox" class="yaq-skip-watched"> 視聴済みを自動スキップ</label>
        </div>
        <div class="yaq-bulk-actions">
          <span class="yaq-group-label">選択した項目を操作:</span>
          <button type="button" data-action="select-page">表示中を選択</button>
          <span class="yaq-selected-count">${selectedItemIds.size}件選択</span>
          <button type="button" data-bulk="watched"${selectedItemIds.size ? "" : " disabled"}>視聴済みにする</button>
          <button type="button" data-bulk="unwatched"${selectedItemIds.size ? "" : " disabled"}>未視聴に戻す</button>
          <button type="button" data-bulk="remove"${selectedItemIds.size ? "" : " disabled"}>キューから除外</button>
          <button type="button" data-action="restore-all"${state.items.some(isPendingDelete) ? "" : " hidden"}>除外をすべて元に戻す</button>
        </div>
        <div class="yaq-manager-message" aria-live="polite">${state.items.some(isPendingDelete) ? `${state.items.filter(isPendingDelete).length}件をキューから除外しています` : ""}</div>
        <div class="yaq-queue-list"></div>
        <div class="yaq-pager">
          <button type="button" data-page="prev">前の100件</button>
          <span class="yaq-page-status"></span>
          <button type="button" data-page="next">次の100件</button>
        </div>
      </div>
    `;
    panel.dataset.expanded = keepListOpen ? "true" : "false";
    panel.querySelector(".yaq-status").textContent = `${state.index + 1} / ${state.items.length}`;
    panel.querySelector(".yaq-current").textContent = current.title;
    panel.querySelector('[data-action="prev"]').disabled = state.index === 0;
    panel.querySelector('[data-action="next"]').disabled = nextQueueIndex(state, state.index) >= state.items.length;
    panel.querySelector('[data-action="prev"]').addEventListener("click", () => goToQueueIndex(state.index - 1));
    panel.querySelector('[data-action="next"]').addEventListener("click", goToNextVideo);
    panel.querySelector('[data-action="toggle-play"]').addEventListener("click", togglePlayback);
    panel.querySelector('[data-action="toggle-list"]').addEventListener("click", () => {
      const queue = panel.querySelector(".yaq-queue");
      if (queue.classList.contains("is-open")) closeQueueManager(panel);
      else {
        panel.dataset.expanded = "true";
        queue.classList.add("is-open");
      }
    });
    const queueOrder = panel.querySelector(".yaq-queue-order");
    queueOrder.value = state.sortOrder === "oldest" ? "oldest" : "newest";
    queueOrder.addEventListener("change", () => {
      if (queueOrder.value !== state.sortOrder) void updateQueue("reverse");
    });
    panel.querySelector('[data-action="close-list"]').addEventListener("click", () => closeQueueManager(panel));
    const searchInput = panel.querySelector(".yaq-search");
    searchInput.value = queueQuery;
    const applySearch = () => {
      queueQuery = searchInput.value;
      queuePage = 0;
      void renderPlayerPanel(true);
    };
    panel.querySelector('[data-action="search"]').addEventListener("click", applySearch);
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") applySearch();
    });
    const watchFilter = panel.querySelector(".yaq-watch-filter");
    watchFilter.value = queueFilter;
    watchFilter.addEventListener("change", () => {
      queueFilter = watchFilter.value;
      queuePage = 0;
      void renderPlayerPanel(true);
    });
    const skipWatched = panel.querySelector(".yaq-skip-watched");
    skipWatched.checked = state.skipWatched !== false;
    skipWatched.addEventListener("change", async () => {
      const latest = await getState();
      if (!latest) return;
      latest.skipWatched = skipWatched.checked;
      await setState(latest);
    });
    panel.querySelector('[data-action="select-page"]').addEventListener("click", () => {
      const rows = [...panel.querySelectorAll(".yaq-queue-item")];
      const shouldSelect = rows.some((row) => !selectedItemIds.has(row.dataset.itemId));
      for (const row of rows) {
        if (shouldSelect) selectedItemIds.add(row.dataset.itemId);
        else selectedItemIds.delete(row.dataset.itemId);
      }
      void renderPlayerPanel(true);
    });
    for (const button of panel.querySelectorAll("[data-bulk]")) {
      button.addEventListener("click", () => applyBulkAction(button.dataset.bulk));
    }
    panel.querySelector('[data-action="restore-all"]').addEventListener("click", async () => {
      const latest = await getState();
      if (!latest) return;
      for (const item of latest.items) {
        item.excluded = false;
        delete item.pendingDeleteUntil;
      }
      await setState(latest);
      await renderPlayerPanel(true);
    });
    panel.querySelector('[data-page="prev"]').addEventListener("click", () => {
      queuePage -= 1;
      void renderPlayerPanel(true);
    });
    panel.querySelector('[data-page="next"]').addEventListener("click", () => {
      queuePage += 1;
      void renderPlayerPanel(true);
    });
    panel.querySelector('[data-action="minimize"]').addEventListener("click", () => minimizePlayerPanel(panel, state));
    panel.querySelector('[data-action="manager"]').addEventListener("click", () => {
      void chrome.runtime.sendMessage({ type: "open-manager" });
    });
    panel.querySelector('[data-action="stop"]').addEventListener("click", () => stopContinuousPlayback(panel, state));

    renderQueueList(panel, state);

    attachEndedListener();
    updatePlaybackButton();
  }

  function togglePlayback() {
    const video = document.querySelector("video.html5-main-video");
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  }

  function updatePlaybackButton() {
    const button = document.querySelector(`#${PANEL_ID} [data-action="toggle-play"]`);
    const video = document.querySelector("video.html5-main-video");
    if (!button || !video) return;
    const isPaused = video.paused;
    button.innerHTML = isPaused ? ICONS.play : ICONS.pause;
    button.setAttribute("aria-label", isPaused ? "再生" : "一時停止");
    button.title = isPaused ? "再生" : "一時停止";
  }

  function attachEndedListener() {
    const video = document.querySelector("video.html5-main-video");
    if (!video) return;
    if (video === attachedVideo) {
      if (!video.paused) void resumePlaybackPosition();
      return;
    }
    attachedVideo?.removeEventListener("ended", handleVideoEnded, true);
    attachedVideo?.removeEventListener("playing", resumePlaybackPosition);
    attachedVideo?.removeEventListener("play", updatePlaybackButton);
    attachedVideo?.removeEventListener("pause", updatePlaybackButton);
    attachedVideo?.removeEventListener("error", handlePlaybackError);
    attachedVideo = video;
    video.addEventListener("ended", handleVideoEnded, true);
    video.addEventListener("playing", resumePlaybackPosition);
    video.addEventListener("play", updatePlaybackButton);
    video.addEventListener("pause", updatePlaybackButton);
    video.addEventListener("error", handlePlaybackError);
    video.addEventListener("loadedmetadata", resumePlaybackPosition, { once: true });
    if (video.readyState >= 1) void resumePlaybackPosition();
    clearInterval(progressTimer);
    progressTimer = setInterval(savePlaybackPosition, PROGRESS_SAVE_INTERVAL_MS);
  }

  async function resumePlaybackPosition() {
    const currentId = videoIdFromUrl(location.href);
    if (!attachedVideo || !currentId || resumedVideoId === currentId) return;
    const state = await getState();
    const item = state?.items?.find((candidate) => candidate.id === currentId);
    const publishedAt =
      document.querySelector('meta[itemprop="uploadDate"]')?.content ||
      document.querySelector('meta[itemprop="datePublished"]')?.content ||
      document.querySelector('meta[property="article:published_time"]')?.content;
    if (item && publishedAt && item.publishedAt !== publishedAt) {
      item.publishedAt = publishedAt;
      state.updatedAt = Date.now();
      await setState(state);
    }
    const seconds = Number(item?.progressSeconds ?? 0);
    if (seconds >= 5 && (!attachedVideo.duration || seconds < attachedVideo.duration - 15)) {
      attachedVideo.currentTime = seconds;
    }
    resumedVideoId = currentId;
  }

  async function savePlaybackPosition() {
    if (!attachedVideo || attachedVideo.paused || !Number.isFinite(attachedVideo.currentTime)) return;
    const currentId = videoIdFromUrl(location.href);
    const state = await getState();
    const item = state?.items?.find((candidate) => candidate.id === currentId);
    if (!item) return;
    item.progressSeconds = Math.floor(attachedVideo.currentTime);
    if (Number.isFinite(attachedVideo.duration)) item.durationSeconds = Math.floor(attachedVideo.duration);
    state.updatedAt = Date.now();
    await setState(state);
  }

  async function handleVideoEnded() {
    const state = await syncCurrentVideo();
    if (!state) return;
    state.items[state.index].watched = true;
    state.items[state.index].progressSeconds = 0;
    await setState(state);
    const nextIndex = nextQueueIndex(state, state.index);
    if (nextIndex >= state.items.length) {
      state.active = false;
      await setState(state);
      const status = document.querySelector(`#${PANEL_ID} .yaq-status`);
      if (status) status.textContent = "キューの再生が完了しました";
      return;
    }
    await goToQueueIndex(nextIndex);
  }

  async function handlePlaybackError() {
    const currentId = videoIdFromUrl(location.href);
    if (!currentId || skippedErrorIds.has(currentId)) return;
    const state = await syncCurrentVideo();
    if (!state) return;
    skippedErrorIds.add(currentId);
    const item = state.items[state.index];
    item.unavailable = true;
    item.watched = true;
    await setState(state);
    const nextIndex = nextQueueIndex(state, state.index);
    if (nextIndex < state.items.length) {
      window.setTimeout(() => goToQueueIndex(nextIndex), 500);
    } else {
      state.active = false;
      await setState(state);
      const status = document.querySelector(`#${PANEL_ID} .yaq-status`);
      if (status) status.textContent = "再生可能な動画が残っていません";
    }
  }

  function detectPlaybackError() {
    const errorNode = document.querySelector(
      "ytd-player-error-message-renderer, yt-playability-error-supported-renderers, .ytp-error"
    );
    if (errorNode && errorNode.getClientRects().length > 0) void handlePlaybackError();
  }

  async function refresh() {
    if (isChannelListPage()) {
      renderListPanel();
      return;
    }
    if (location.pathname === "/watch" || location.pathname.startsWith("/shorts/")) {
      await renderPlayerPanel();
      return;
    }
    document.getElementById(PANEL_ID)?.remove();
  }

  document.addEventListener("yt-navigate-finish", () => {
    lastUrl = location.href;
    updateFullscreenState();
    detectPlaybackError();
    void refresh();
  });

  document.addEventListener("fullscreenchange", updateFullscreenState);

  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      void refresh();
    }
    updateFullscreenState();
    detectPlaybackError();
    if (document.getElementById(PANEL_ID)?.dataset.kind === "player") attachEndedListener();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  updateFullscreenState();
  void refresh();
})();

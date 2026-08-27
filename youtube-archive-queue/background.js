async function openManager() {
  const managerUrl = chrome.runtime.getURL("manager.html");
  const existing = await chrome.tabs.query({ url: `${managerUrl}*` });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: managerUrl });
}

chrome.action.onClicked.addListener(openManager);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "open-manager") void openManager();
});

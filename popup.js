const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["apiKey", "model"]).then(({ apiKey, model }) => {
  if (apiKey) $("key").value = apiKey;
  $("model").value = model || "gpt-4o-mini";
});

$("save").onclick = async () => {
  await chrome.storage.local.set({ apiKey: $("key").value.trim(), model: $("model").value.trim() || "gpt-4o-mini" });
  $("msg").textContent = "저장했습니다.";
};

$("start").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
    $("msg").style.color = "#dc2626";
    $("msg").textContent = "이 페이지에서는 사용할 수 없습니다.";
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "inject", tabId: tab.id });
  if (res?.ok) window.close();
  else { $("msg").style.color = "#dc2626"; $("msg").textContent = res?.error || "주입 실패"; }
};

let activeTabId = null;
let currentResult = null;

const $ = (id) => document.getElementById(id);

function show(view) {
  for (const id of ["welcome", "loading", "error", "result"]) {
    $(id).classList.toggle("hidden", id !== view);
  }
}

function isBilibiliVideo(url) {
  return /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]+/i.test(String(url || ""));
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
    : `${minutes}:${String(secs).padStart(2, "0")}`;
}

function safeFilename(value) {
  return String(value || "B站逐字稿").replace(/[\\/:*?"<>|]/g, "-").slice(0, 100);
}

async function findVideoTab() {
  const active = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active[0] && isBilibiliVideo(active[0].url)) return active[0];
  return null;
}

function render(result) {
  currentResult = result;
  $("videoTitle").textContent = result.video.title;
  $("videoOwner").textContent = result.video.owner ? `UP主：${result.video.owner}` : "";
  $("languageBadge").textContent = result.language;
  $("sourceInfo").textContent = `来源：${result.video.bvid} · 原始字幕 ${result.rawLineCount || result.transcript.length} 条 · 整理为 ${result.paragraphCount || result.transcript.length} 段`;
  const list = $("transcriptList");
  list.textContent = "";
  for (const line of result.transcript) {
    const row = document.createElement("button");
    row.className = "transcript-row";
    row.dataset.seconds = String(line.start);
    const time = document.createElement("span");
    time.className = "timestamp";
    time.textContent = formatTimestamp(line.start);
    const text = document.createElement("span");
    text.className = "transcript-text";
    text.textContent = line.text;
    row.append(time, text);
    row.addEventListener("click", () => seek(line.start));
    list.appendChild(row);
  }
  show("result");
}

async function loadTranscript() {
  currentResult = null;
  $("status").textContent = "";
  const tab = await findVideoTab();
  if (!tab) {
    activeTabId = null;
    $("welcome").querySelector("p").textContent = "请先切换到需要处理的 B 站视频标签页，再点击“生成当前视频逐字稿”。扩展不会读取其他后台标签页。";
    show("welcome");
    return;
  }
  activeTabId = tab.id;
  show("loading");
  try {
    const result = await chrome.runtime.sendMessage({
      action: "GET_BILIBILI_TRANSCRIPT",
      videoUrl: tab.url,
    });
    if (!result?.success) throw new Error(result?.message || "读取字幕失败，请刷新视频页面后重试。");
    render(result);
  } catch (error) {
    $("errorMessage").textContent = error.message || "读取字幕失败，请刷新视频页面后重试。";
    show("error");
  }
}

async function seek(seconds) {
  if (!activeTabId) return;
  await chrome.tabs.sendMessage(activeTabId, { action: "SEEK_BILIBILI", seconds }).catch(() => {});
}

async function copyTranscript() {
  if (!currentResult) return;
  await navigator.clipboard.writeText(currentResult.timestampedText);
  $("status").textContent = "已复制带时间戳的逐字稿。";
}

function locationForVideo() {
  return currentResult?.video?.bvid
    ? `https://www.bilibili.com/video/${currentResult.video.bvid}`
    : "";
}

function downloadTranscript() {
  if (!currentResult) return;
  const header = `${currentResult.video.title}\n${locationForVideo()}\n语言：${currentResult.language}\n\n`;
  const blob = new Blob([header + currentResult.timestampedText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFilename(currentResult.video.title)}-逐字稿.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("status").textContent = "已导出 TXT 文件。";
}

$("refreshButton").addEventListener("click", loadTranscript);
$("generateButton").addEventListener("click", loadTranscript);
$("retryButton").addEventListener("click", loadTranscript);
$("copyButton").addEventListener("click", copyTranscript);
$("downloadButton").addEventListener("click", downloadTranscript);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && changeInfo.url) {
    activeTabId = null;
    currentResult = null;
    show("welcome");
  }
});
chrome.tabs.onActivated.addListener(() => {
  activeTabId = null;
  currentResult = null;
  show("welcome");
});

// Deliberately do not fetch on panel open or tab changes. The user chooses
// which videos deserve a transcript by pressing the Generate button.
show("welcome");

globalThis.__BILIBILI_PANEL_TESTING__ = { isBilibiliVideo, formatTimestamp, safeFilename };

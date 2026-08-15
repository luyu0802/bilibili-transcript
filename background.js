function extractBvid(url) {
  return String(url || "").match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || "";
}

function currentPageNumber(url) {
  const value = Number(new URL(url).searchParams.get("p") || "1");
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function chooseSubtitle(items) {
  if (!items.length) return null;
  const score = (item) => {
    const lang = String(item.lan || "").toLowerCase();
    const label = String(item.lan_doc || "");
    if (lang === "zh-cn" || /中文（简体）|简体中文/.test(label)) return 100;
    if (lang.startsWith("zh") || /中文/.test(label)) return 80;
    return 10;
  };
  return [...items].sort((a, b) => score(b) - score(a))[0];
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

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeTranscriptLines(lines, options = {}) {
  const maxChars = options.maxChars || 90;
  const maxDuration = options.maxDuration || 22;
  const maxGap = options.maxGap || 2.2;
  const cleaned = [];
  for (const raw of lines || []) {
    const text = normalizeCaptionText(raw.text ?? raw.content);
    if (!text) continue;
    const start = Number(raw.start ?? raw.from) || 0;
    const end = Number(raw.end ?? raw.to) || start;
    const previous = cleaned[cleaned.length - 1];
    // Some Bilibili subtitle tracks repeat an identical caption at the same
    // timestamp. Keep one copy without dropping legitimate later repetition.
    if (previous && previous.text === text && Math.abs(previous.start - start) < 0.4) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    cleaned.push({ start, end, text });
  }

  const paragraphs = [];
  let current = null;
  const sentenceEnd = /[。！？!?…]$/;
  for (const line of cleaned) {
    if (!current) {
      current = { ...line };
      continue;
    }
    const gap = line.start - current.end;
    const combinedLength = current.text.length + line.text.length;
    const duration = line.end - current.start;
    const shouldBreak =
      gap > maxGap ||
      combinedLength > maxChars ||
      duration > maxDuration ||
      (sentenceEnd.test(current.text) && current.text.length >= 24);
    if (shouldBreak) {
      paragraphs.push(current);
      current = { ...line };
    } else {
      const needsSpace = /[A-Za-z0-9]$/.test(current.text) && /^[A-Za-z0-9]/.test(line.text);
      current.text += (needsSpace ? " " : "") + line.text;
      current.end = Math.max(current.end, line.end);
    }
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}

async function getJson(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
  const json = await response.json();
  if (typeof json.code === "number" && json.code !== 0) {
    throw new Error(json.message || `B站接口错误（${json.code}）`);
  }
  return json;
}

async function fetchTranscript(videoUrl) {
  const bvid = extractBvid(videoUrl);
  if (!bvid) throw new Error("请先打开一个 B 站普通视频页面。");
  const view = await getJson(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  const pageNumber = currentPageNumber(videoUrl);
  const pages = Array.isArray(view.data?.pages) ? view.data.pages : [];
  const page = pages[pageNumber - 1] || pages[0];
  if (!page?.cid) throw new Error("无法确定当前视频分P。");
  const player = await getJson(
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(page.cid)}`,
  );
  const selected = chooseSubtitle(player.data?.subtitle?.subtitles || []);
  if (!selected?.subtitle_url) {
    return {
      success: false,
      error: "NO_SUBTITLE",
      message: "这个视频没有可用字幕。请确认播放器的 CC 字幕菜单中存在中文字幕；纯弹幕不属于字幕。",
    };
  }
  const subtitleUrl = selected.subtitle_url.startsWith("//")
    ? `https:${selected.subtitle_url}`
    : selected.subtitle_url;
  const subtitle = await getJson(subtitleUrl);
  const rawTranscript = (subtitle.body || [])
    .map((line) => ({
      start: Number(line.from) || 0,
      end: Number(line.to) || Number(line.from) || 0,
      text: normalizeCaptionText(line.content),
    }))
    .filter((line) => line.text);
  const transcript = mergeTranscriptLines(rawTranscript);
  if (!transcript.length) {
    return { success: false, error: "EMPTY_SUBTITLE", message: "字幕轨道存在，但内容为空。" };
  }
  const title = pageNumber > 1 && page.part
    ? `${view.data.title} - P${pageNumber} ${page.part}`
    : view.data.title;
  return {
    success: true,
    video: {
      bvid,
      cid: page.cid,
      pageNumber,
      title,
      owner: view.data.owner?.name || "",
      duration: page.duration || view.data.duration || 0,
    },
    language: selected.lan_doc || selected.lan || "中文字幕",
    transcript,
    rawLineCount: rawTranscript.length,
    paragraphCount: transcript.length,
    timestampedText: transcript.map((line) => `[${formatTimestamp(line.start)}] ${line.text}`).join("\n"),
    plainText: transcript.map((line) => line.text).join("\n"),
  };
}

// Configure the toolbar action immediately whenever the service worker starts.
// This also covers extensions loaded while a Bilibili tab is already open.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== "GET_BILIBILI_TRANSCRIPT") return;
  fetchTranscript(message.videoUrl).then(sendResponse).catch((error) => {
    sendResponse({ success: false, error: "FETCH_FAILED", message: error.message || "读取字幕失败。" });
  });
  return true;
});

globalThis.__BILIBILI_TRANSCRIPT_TESTING__ = {
  extractBvid,
  currentPageNumber,
  chooseSubtitle,
  formatTimestamp,
  mergeTranscriptLines,
};

(function () {
  "use strict";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action !== "SEEK_BILIBILI") return;
    const video = document.querySelector("video");
    if (!video) {
      sendResponse({ success: false, message: "找不到视频播放器。" });
      return;
    }
    video.currentTime = Math.max(0, Number(message.seconds) || 0);
    video.play().catch(() => {});
    sendResponse({ success: true });
  });
})();

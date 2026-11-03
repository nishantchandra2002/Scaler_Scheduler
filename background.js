// Scaler Class Scheduler - background service worker
// Keeps the run going while the Scaler tab is in the background:
//  - "tick": a timer the content script waits on. Chrome throttles timers in
//    hidden tabs (1/sec, then 1/min after ~5 min); service-worker timers are not.
//  - "keepTab": stops Chrome's Memory Saver from discarding the tab mid-run.

'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'tick') {
    const ms = Math.max(0, Math.min(Number(msg.ms) || 0, 20000));
    setTimeout(() => sendResponse(true), ms);
    return true; // async response
  }

  if (msg?.action === 'keepTab' && sender.tab?.id != null) {
    chrome.tabs.update(sender.tab.id, { autoDiscardable: !msg.keep }, () => {
      void chrome.runtime.lastError;
      sendResponse(true);
    });
    return true;
  }

  return false;
});

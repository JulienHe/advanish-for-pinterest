chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'parp-download' && message.url) {
    chrome.downloads.download({ url: message.url, saveAs: false });
  }
  return false;
});

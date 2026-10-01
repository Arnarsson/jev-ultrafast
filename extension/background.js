// Clicking the toolbar icon (or Cmd/Ctrl+Shift+J) opens the side panel for the current window.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

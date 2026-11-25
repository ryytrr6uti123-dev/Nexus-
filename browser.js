const webview = document.querySelector('#page');
const addressInput = document.querySelector('#address');
const searchEngine = document.querySelector('#search-engine');
const pageTitle = document.querySelector('#page-title');
const statusMessage = document.querySelector('#status-message');
const loading = document.querySelector('#loading');
const backButton = document.querySelector('#back');
const forwardButton = document.querySelector('#forward');
const reloadButton = document.querySelector('#reload');
let webviewReady = true;
let pendingInitialUrl = '';

function showStatus(message) {
  statusMessage.textContent = message;
  statusMessage.classList.toggle('visible', Boolean(message));
}

function updateNavigationButtons() {
  backButton.disabled = !webview.canGoBack();
  forwardButton.disabled = !webview.canGoForward();
}

async function navigate(value) {
  try {
    if (isSearchQuery(value)) {
      window.browser.recordSearch(value.trim()).catch((error) => {
        console.error('Could not sync browser search history.', error);
      });
    }
    const url = await window.browser.resolveAddress(value, searchEngine.value);
    addressInput.value = url;
    loading.hidden = false;
    showStatus('');
    if (webviewReady) webview.loadURL(url);
    else pendingInitialUrl = url;
  } catch (error) {
    loading.hidden = true;
    showStatus(error.message);
  }
}

function isSearchQuery(value) {
  const input = value.trim();
  return Boolean(input)
    && !/^https?:\/\//i.test(input)
    && !/^[\w.-]+(?::\d+)?(?:[/?#].*)?$/.test(input);
}

document.querySelector('#address-form').addEventListener('submit', (event) => {
  event.preventDefault();
  navigate(addressInput.value);
});

document.querySelector('#new-window').addEventListener('click', async () => {
  try {
    const home = searchEngine.value === 'bing'
      ? 'https://www.bing.com/'
      : 'https://duckduckgo.com/';
    await window.browser.openBrowserWindow(home);
  } catch (error) {
    showStatus(error.message);
  }
});

backButton.addEventListener('click', () => {
  if (webviewReady && webview.canGoBack()) webview.goBack();
});
forwardButton.addEventListener('click', () => {
  if (webviewReady && webview.canGoForward()) webview.goForward();
});
reloadButton.addEventListener('click', () => {
  if (!webviewReady) return;
  if (webview.isLoading()) webview.stop();
  else webview.reload();
});

webview.addEventListener('dom-ready', () => {
  webviewReady = true;
  updateNavigationButtons();
  if (pendingInitialUrl) {
    webview.loadURL(pendingInitialUrl);
    pendingInitialUrl = '';
  }
});
webview.addEventListener('did-start-loading', () => {
  loading.hidden = false;
  reloadButton.textContent = '×';
  reloadButton.title = 'Stop loading';
});
webview.addEventListener('did-stop-loading', () => {
  loading.hidden = true;
  reloadButton.textContent = '↻';
  reloadButton.title = 'Reload';
  updateNavigationButtons();
});
webview.addEventListener('did-navigate', (event) => {
  addressInput.value = event.url;
  updateNavigationButtons();
});
webview.addEventListener('did-navigate-in-page', (event) => {
  addressInput.value = event.url;
  updateNavigationButtons();
});
webview.addEventListener('page-title-updated', (event) => {
  pageTitle.textContent = event.title || 'Nexus Browser';
});
webview.addEventListener('did-fail-load', (event) => {
  if (event.isMainFrame && event.errorCode !== -3) {
    loading.hidden = true;
    showStatus(`Couldn't load this page: ${event.errorDescription}`);
  }
});

window.browser.onInitialUrl((url) => {
  addressInput.value = url;
  pendingInitialUrl = url;
  if (webviewReady) {
    webview.loadURL(url);
    pendingInitialUrl = '';
  }
});
window.browser.onFocusAddress(() => {
  addressInput.focus();
  addressInput.select();
});
window.browser.getAdblockStatus().then((status) => {
  showStatus(status.message);
}).catch((error) => {
  console.error('Could not read the ad-blocker status.', error);
  showStatus('Ad-blocker status is unavailable.');
});

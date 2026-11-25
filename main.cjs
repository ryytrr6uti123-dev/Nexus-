const path = require('node:path');
const fs = require('node:fs/promises');
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { isWebUrl, resolveAddress } = require('./address.cjs');
const { getGameCatalog } = require('./games.cjs');
const { AiQuotaStore, askAiWithQuota, createAiQuotaKey } = require('./ai.cjs');
const { searchMusic } = require('./music.cjs');
const { ProfileStore } = require('./profiles.cjs');

const trustedInterfaces = new Set();
const browserWindows = new Set();
let desktopWindow;
let profileStore;
let aiQuotaStore;
let profileSessionToken = '';
let adblockStatus = {
  enabled: false,
  message: 'The ad blocker has not finished starting.',
};

function sendBrowserCount() {
  if (desktopWindow && !desktopWindow.isDestroyed()) {
    desktopWindow.webContents.send('browser:count', browserWindows.size);
  }
}

function configureWebContents(hostWindow) {
  const { webContents } = hostWindow;
  trustedInterfaces.add(webContents);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (
      (params.src && params.src !== 'about:blank' && !isWebUrl(params.src))
      || params.partition !== 'persist:nexus-browser'
    ) {
      event.preventDefault();
      return;
    }

    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) {
        openBrowserWindow(url);
      }
      return { action: 'deny' };
    });
    guest.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
    guest.on('will-redirect', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
      const key = input.key.toLowerCase();
      if (key === 'l') {
        event.preventDefault();
        webContents.send('browser:focus-address');
      } else if (key === 'r') {
        event.preventDefault();
        guest.reload();
      } else if (key === 't') {
        event.preventDefault();
        openBrowserWindow('https://duckduckgo.com/');
      }
    });
  });

  hostWindow.on('closed', () => trustedInterfaces.delete(webContents));
}

function openBrowserWindow(address = 'https://duckduckgo.com/') {
  if (!adblockStatus.enabled) {
    throw new Error(adblockStatus.message);
  }
  if (!isWebUrl(address)) {
    throw new Error('Browser windows only support http and https addresses.');
  }

  const browserWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#080b10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  browserWindow.maximize();
  browserWindows.add(browserWindow);
  configureWebContents(browserWindow);
  browserWindow.on('closed', () => {
    browserWindows.delete(browserWindow);
    sendBrowserCount();
  });
  browserWindow.loadFile('browser.html');
  browserWindow.webContents.once('did-finish-load', () => {
    if (!browserWindow.isDestroyed()) {
      browserWindow.webContents.send('browser:initial-url', address);
    }
  });
  sendBrowserCount();
  return browserWindow;
}

function createDesktopWindow() {
  desktopWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#07090d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  configureWebContents(desktopWindow);
  desktopWindow.on('closed', () => {
    trustedInterfaces.delete(desktopWindow?.webContents);
    desktopWindow = undefined;
  });
  desktopWindow.loadFile('index.html');
}



ipcMain.handle('browser:resolve-address', (event, value, engine) => {
  if (!trustedInterfaces.has(event.sender)) {
    throw new Error('Address resolution is only available to Nexus browser windows.');
  }
  return resolveAddress(value, engine);
});

ipcMain.handle('browser:open-window', (event, address) => {
  if (!trustedInterfaces.has(event.sender)) {
    throw new Error('Only Nexus windows can open browser windows.');
  }
  openBrowserWindow(address);
  return true;
});

ipcMain.handle('browser:adblock-status', (event) => {
  if (!trustedInterfaces.has(event.sender)) {
    throw new Error('Ad-blocker status is only available to Nexus windows.');
  }
  return adblockStatus;
});

ipcMain.handle('games:list', (event) => {
  assertTrustedInterface(event, 'Game catalog access');
  return getGameCatalog();
});

async function getAiQuotaKey() {
  const accountId = await profileStore.getAccountId(profileSessionToken);
  return accountId
    ? createAiQuotaKey('profile', accountId)
    : createAiQuotaKey('electron-install', app.getPath('userData'));
}

ipcMain.handle('ai:usage', async event => {
  assertTrustedInterface(event, 'AI token balance');
  return aiQuotaStore.getUsage(await getAiQuotaKey());
});

ipcMain.handle('ai:chat', async (event, messages, mode) => {
  assertTrustedInterface(event, 'AI assistant');
  return askAiWithQuota(messages, mode, {
    quotaStore: aiQuotaStore,
    quotaKey: await getAiQuotaKey(),
  });
});

function assertTrustedInterface(event, action) {
  if (!trustedInterfaces.has(event.sender)) {
    throw new Error(`${action} is only available to Nexus windows.`);
  }
}

function broadcastProfileUpdate(profile) {
  for (const webContents of trustedInterfaces) {
    if (!webContents.isDestroyed()) webContents.send('profile:updated', profile);
  }
}

ipcMain.handle('music:search', (event, query) => {
  assertTrustedInterface(event, 'Music search');
  return searchMusic(query);
});

ipcMain.handle('profile:register', async (event, username, password) => {
  assertTrustedInterface(event, 'Profile registration');
  const result = await profileStore.register(username, password);
  profileSessionToken = result.token;
  broadcastProfileUpdate(result.profile);
  return result.profile;
});

ipcMain.handle('profile:login', async (event, username, password) => {
  assertTrustedInterface(event, 'Profile sign-in');
  const result = await profileStore.login(username, password);
  profileSessionToken = result.token;
  broadcastProfileUpdate(result.profile);
  return result.profile;
});

ipcMain.handle('profile:get', async event => {
  assertTrustedInterface(event, 'Profile access');
  return profileStore.getProfile(profileSessionToken);
});

ipcMain.handle('profile:save-data', async (event, data) => {
  assertTrustedInterface(event, 'Profile activity sync');
  const profile = await profileStore.saveProfileData(profileSessionToken, data);
  broadcastProfileUpdate(profile);
  return profile;
});

ipcMain.handle('profile:update-account', async (event, updates) => {
  assertTrustedInterface(event, 'Profile updates');
  const profile = await profileStore.updateAccount(profileSessionToken, updates);
  broadcastProfileUpdate(profile);
  return profile;
});

ipcMain.handle('profile:logout', async event => {
  assertTrustedInterface(event, 'Profile sign-out');
  await profileStore.logout(profileSessionToken);
  profileSessionToken = '';
  broadcastProfileUpdate(null);
  return true;
});

ipcMain.handle('profile:record-search', async (event, query) => {
  assertTrustedInterface(event, 'Search history');
  const value = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  if (!value || !profileSessionToken) return false;
  const profile = await profileStore.getProfile(profileSessionToken);
  if (!profile) return false;
  const recentSearches = [
    value,
    ...profile.data.recentSearches.filter(item => item.toLocaleLowerCase() !== value.toLocaleLowerCase()),
  ].slice(0, 50);
  await profileStore.saveProfileData(profileSessionToken, {
    ...profile.data,
    recentSearches,
  });
  broadcastProfileUpdate({
    ...profile,
    data: { ...profile.data, recentSearches },
  });
  return true;
});

async function initializeAdBlocker(browserSession) {
  try {
    const userDataPath = app.getPath('userData');
    await fs.mkdir(userDataPath, { recursive: true });
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(userDataPath, 'nexus-adblocker.bin'),
      read: fs.readFile,
      write: fs.writeFile,
    });
    // Ghostery's cosmetic-filter preload uses process-wide IPC handlers, so both sessions use network filtering.
    blocker.config.loadCosmeticFilters = false;
    blocker.enableBlockingInSession(session.defaultSession);
    blocker.enableBlockingInSession(browserSession);
    adblockStatus = { enabled: true, message: 'The ad blocker is enabled.' };
  } catch (error) {
    adblockStatus = {
      enabled: false,
      message: 'The ad blocker could not load its filter lists. Browser windows are disabled.',
    };
    console.error('Could not initialize the Nexus ad blocker.', error);
  }
}

app.whenReady().then(async () => {
  profileStore = new ProfileStore(path.join(app.getPath('userData'), 'profiles.json'));
  await profileStore.ready;
  aiQuotaStore = new AiQuotaStore(path.join(app.getPath('userData'), 'ai-usage.json'));
  await aiQuotaStore.ready;
  const browserSession = session.fromPartition('persist:nexus-browser');
  browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  await initializeAdBlocker(browserSession);
  createDesktopWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createDesktopWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

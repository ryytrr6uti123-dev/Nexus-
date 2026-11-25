const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  resolveAddress: (value, engine) => ipcRenderer.invoke('browser:resolve-address', value, engine),
  openBrowserWindow: (address) => ipcRenderer.invoke('browser:open-window', address),
  getAdblockStatus: () => ipcRenderer.invoke('browser:adblock-status'),
  getGameCatalog: () => ipcRenderer.invoke('games:list'),
  sendAiPrompt: (messages, mode) => ipcRenderer.invoke('ai:chat', messages, mode),
  getAiUsage: () => ipcRenderer.invoke('ai:usage'),
  searchMusic: query => ipcRenderer.invoke('music:search', query),
  registerProfile: (username, password) => ipcRenderer.invoke('profile:register', username, password),
  loginProfile: (username, password) => ipcRenderer.invoke('profile:login', username, password),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfileData: data => ipcRenderer.invoke('profile:save-data', data),
  updateProfile: updates => ipcRenderer.invoke('profile:update-account', updates),
  logoutProfile: () => ipcRenderer.invoke('profile:logout'),
  recordSearch: query => ipcRenderer.invoke('profile:record-search', query),
  onNewWindow: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('browser:new-window', listener);
    return () => ipcRenderer.removeListener('browser:new-window', listener);
  },
  onFocusAddress: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('browser:focus-address', listener);
    return () => ipcRenderer.removeListener('browser:focus-address', listener);
  },
  onInitialUrl: (callback) => {
    const listener = (_event, url) => callback(url);
    ipcRenderer.on('browser:initial-url', listener);
    return () => ipcRenderer.removeListener('browser:initial-url', listener);
  },
  onCount: (callback) => {
    const listener = (_event, count) => callback(count);
    ipcRenderer.on('browser:count', listener);
    return () => ipcRenderer.removeListener('browser:count', listener);
  },
  onProfileUpdated: (callback) => {
    const listener = (_event, profile) => callback(profile);
    ipcRenderer.on('profile:updated', listener);
    return () => ipcRenderer.removeListener('profile:updated', listener);
  },
});

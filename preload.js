const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vox", {
  scanDrivers: () => ipcRenderer.invoke("drivers:scan"),
  rescanHardware: () => ipcRenderer.invoke("drivers:rescan"),
  wuSearch: () => ipcRenderer.invoke("drivers:wuSearch"),
  wuInstall: ids => ipcRenderer.invoke("drivers:wuInstall", ids),
  installInf: () => ipcRenderer.invoke("drivers:installInf"),
  deviceAction: (id, action) => ipcRenderer.invoke("device:action", id, action),
  setDefaultEndpoint: ep => ipcRenderer.invoke("endpoint:setDefault", ep),
  enableEndpoint: ep => ipcRenderer.invoke("endpoint:enable", ep),
  openTool: name => ipcRenderer.invoke("tool:open", name),
  searchDriver: q => ipcRenderer.invoke("web:search", q),
  restoreOnQuit: ep => ipcRenderer.invoke("endpoint:restoreOnQuit", ep),
  openUrl: url => ipcRenderer.invoke("web:open", url),
  info: () => ipcRenderer.invoke("app:info"),
  onHotkey: cb => ipcRenderer.on("hotkey", (_e, a) => cb(a))
});

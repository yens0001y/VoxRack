const { app, BrowserWindow, ipcMain, globalShortcut, shell, session, Menu, dialog } = require("electron");
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Request the smallest audio buffer Chromium allows, and keep audio running when the window is in the background.
app.commandLine.appendSwitch("audio-buffer-size", "128");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

let win = null;

// Core Audio COM: read/set the Windows default endpoint and re-enable endpoints hidden in Sound settings. No admin needed.
const AUDIO_CS = `
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
namespace Vox {
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat();
    int GetProcessingPeriod(); int SetProcessingPeriod(); int GetShareMode(); int SetShareMode();
    int GetPropertyValue(); int SetPropertyValue();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
  }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(); int OpenPropertyStore(); [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(); [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  public static class Audio {
    public static string GetDefault(int flow) {
      IMMDevice d; var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      if (e.GetDefaultAudioEndpoint(flow, 0, out d) != 0 || d == null) return null;
      string id; d.GetId(out id); return id;
    }
    public static int SetDefault(string id) {
      var p = (IPolicyConfig)new PolicyConfigClient(); int hr = 0;
      for (int r = 0; r < 3; r++) hr |= p.SetDefaultEndpoint(id, r);
      return hr;
    }
    public static int SetVisible(string id, bool v) { return ((IPolicyConfig)new PolicyConfigClient()).SetEndpointVisibility(id, v ? 1 : 0); }
  }
}
'@
`;

const SCAN_PS = AUDIO_CS + `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$defR = [Vox.Audio]::GetDefault(0); $defC = [Vox.Audio]::GetDefault(1)
$d = @(Get-PnpDevice -Class MEDIA)
$bad = @(Get-PnpDevice -PresentOnly | Where-Object {
  $_.Status -ne 'OK' -and $_.Class -notin 'MEDIA','AudioEndpoint' -and (
    $_.InstanceId -like 'HDAUDIO*' -or $_.FriendlyName -match 'audio|sound|microphone|speaker|headset|realtek|codec') })
$k = 'DEVPKEY_Device_DriverVersion','DEVPKEY_Device_DriverProvider','DEVPKEY_Device_DriverDate','DEVPKEY_Device_Manufacturer',
     'DEVPKEY_Device_HardwareIds','DEVPKEY_Device_ProblemCode','DEVPKEY_Device_DriverInfPath'
$hw = foreach ($x in @($d + $bad)) {
  $p = @{}
  Get-PnpDeviceProperty -InstanceId $x.InstanceId -KeyName $k | ForEach-Object { $p[$_.KeyName] = $_.Data }
  $dt = $p['DEVPKEY_Device_DriverDate']
  [pscustomobject]@{
    id = $x.InstanceId; name = $x.FriendlyName; cls = "$($x.Class)"; status = "$($x.Status)"; present = [bool]$x.Present
    ver = $p['DEVPKEY_Device_DriverVersion']; prov = $p['DEVPKEY_Device_DriverProvider']
    date = $(if ($dt) { $dt.ToString('yyyy-MM-dd') } else { $null })
    mfr = $p['DEVPKEY_Device_Manufacturer']; hwids = @($p['DEVPKEY_Device_HardwareIds'])
    problem = $p['DEVPKEY_Device_ProblemCode']; inf = $p['DEVPKEY_Device_DriverInfPath']
  }
}
# Endpoints come from the MMDevices registry, which also lists unplugged jacks and endpoints disabled in Sound settings.
# DeviceState: 1 active, 2 disabled, 4 not present, 8 unplugged; high bits mark endpoints Windows never shows.
$mm = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio'
$eps = foreach ($f in 'Render','Capture') {
  $fl = $(if ($f -eq 'Render') { 0 } else { 1 })
  Get-ChildItem "$mm\\$f" | ForEach-Object {
    $st = [int64](Get-ItemProperty $_.PSPath).DeviceState
    if ($st -ge 0x10000) { return }
    $pr = Get-ItemProperty "$($_.PSPath)\\Properties"
    $ep = "{0.0.$fl.00000000}.$($_.PSChildName)".ToLower()
    [pscustomobject]@{
      ep = $ep; flow = $(if ($fl) { 'in' } else { 'out' }); state = $st
      name = $pr.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'; dev = $pr.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
      parent = ($pr.'{b3f8fa53-0004-438e-9003-51a46e139bfc},2' -replace '^\\{\\d+\\}\\.', '')
      isDefault = ($ep -eq $defR -or $ep -eq $defC)
    }
  }
}
ConvertTo-Json -InputObject @{ hw = @($hw); eps = @($eps) } -Depth 4 -Compress
`;

// Windows Update Agent: the same catalogue "Optional updates > Driver updates" uses. Searching needs no admin.
const WU_SEARCH_PS = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$q = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
$q.ServerSelection = 2
$res = $q.Search("IsInstalled=0 and Type='Driver'")
$out = foreach ($u in $res.Updates) { [pscustomobject]@{
  id = $u.Identity.UpdateID; title = $u.Title; hwid = $u.DriverHardwareID; cls = $u.DriverClass; prov = $u.DriverProvider
  model = $u.DriverModel; date = $(if ($u.DriverVerDate) { $u.DriverVerDate.ToString('yyyy-MM-dd') } else { $null }); size = $u.MaxDownloadSize } }
ConvertTo-Json -InputObject @($out) -Compress
`;

function runPS(script, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

const psStr = s => "'" + String(s).replace(/'/g, "''") + "'";

// Runs a script as administrator through UAC. The script's output is captured to a file because an elevated
// process cannot write to our pipes. Returns { ok, code, out } or { ok:false, cancelled:true } if UAC was declined.
async function runElevated(body, timeout = 10 * 60000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voxrack-"));
  const job = path.join(dir, "job.ps1"), log = path.join(dir, "out.txt");
  fs.writeFileSync(job, "﻿$ErrorActionPreference = 'Continue'\n$global:code = 0\n& {\n" + body + "\n} *>&1 | Out-File -Encoding utf8 " + psStr(log) + "\nexit $global:code\n", "utf8");
  const launcher = `try {
  $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psStr('"' + job + '"')}
  Write-Output "EXIT:$($p.ExitCode)"
} catch { Write-Output 'CANCELLED' }`;
  try {
    const res = (await runPS(launcher, timeout)).trim();
    if (res.includes("CANCELLED")) return { ok: false, cancelled: true };
    const code = +((res.match(/EXIT:(-?\d+)/) || [])[1] || 0);
    let out = "";
    try { out = fs.readFileSync(log, "utf8").replace(/^﻿/, "").trim(); } catch (e) {}
    return { ok: code === 0 || code === 3010, reboot: code === 3010, code, out };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ok = fn => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, error: e.message }; } };
const INSTANCE_RE = /^[A-Za-z0-9\\&{}.#_\-]+$/;
const ENDPOINT_RE = /^\{0\.0\.[01]\.\d+\}\.\{[0-9a-f-]+\}$/i;
const GUID_RE = /^[0-9a-f-]{36}$/i;

ipcMain.handle("drivers:scan", async () => {
  const t = Date.now();
  const out = (await runPS(SCAN_PS)).trim();
  const r = out ? JSON.parse(out) : {};
  return { hw: r.hw || [], eps: r.eps || [], ms: Date.now() - t, at: new Date().toISOString() };
});

ipcMain.handle("drivers:rescan", ok(async () => {
  // Same as Device Manager > Action > Scan for hardware changes.
  return runElevated("pnputil /scan-devices; $global:code = $LASTEXITCODE", 60000);
}));

ipcMain.handle("drivers:wuSearch", ok(async () => {
  const out = (await runPS(WU_SEARCH_PS, 5 * 60000)).trim();
  return { ok: true, list: out ? JSON.parse(out) : [] };
}));

ipcMain.handle("drivers:wuInstall", ok(async (_e, ids) => {
  ids = [].concat(ids).filter(i => GUID_RE.test(i));
  if (!ids.length) return { ok: false, error: "no update" };
  const crit = ids.map(i => `UpdateID='${i}'`).join(" or ");
  return runElevated(`
$s = New-Object -ComObject Microsoft.Update.Session
$q = $s.CreateUpdateSearcher(); $q.ServerSelection = 2
$found = $q.Search("${crit}").Updates
if ($found.Count -eq 0) { 'not found'; $global:code = 2; return }
$col = New-Object -ComObject Microsoft.Update.UpdateColl
foreach ($u in $found) { $u.AcceptEula(); [void]$col.Add($u) }
$dl = $s.CreateUpdateDownloader(); $dl.Updates = $col; $d = $dl.Download()
"download=$($d.ResultCode)"
$ins = $s.CreateUpdateInstaller(); $ins.Updates = $col; $r = $ins.Install()
"install=$($r.ResultCode) reboot=$($r.RebootRequired)"
if ($r.ResultCode -ne 2) { $global:code = 1 } elseif ($r.RebootRequired) { $global:code = 3010 }`);
}));

ipcMain.handle("device:action", ok(async (_e, id, action) => {
  if (!INSTANCE_RE.test(id) || !["enable", "disable", "restart"].includes(action)) return { ok: false, error: "bad request" };
  return runElevated(`pnputil /${action}-device ${psStr(id)}; $global:code = $LASTEXITCODE`, 60000);
}));

ipcMain.handle("drivers:installInf", ok(async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "เลือกไฟล์ไดรเวอร์ (.inf) ที่แตกไฟล์จากเว็บผู้ผลิตแล้ว",
    filters: [{ name: "Driver INF", extensions: ["inf"] }], properties: ["openFile"]
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, noFile: true };
  // Installing the folder's packages too covers vendor bundles that split the codec, APO and service INFs.
  const dir = path.dirname(r.filePaths[0]);
  return runElevated(`pnputil /add-driver ${psStr(path.join(dir, "*.inf"))} /subdirs /install; $global:code = $LASTEXITCODE`);
}));

ipcMain.handle("endpoint:setDefault", ok(async (_e, ep) => {
  if (!ENDPOINT_RE.test(ep)) return { ok: false, error: "bad endpoint" };
  const hr = (await runPS(AUDIO_CS + `[Vox.Audio]::SetDefault(${psStr(ep)})`)).trim();
  return { ok: hr === "0", error: hr === "0" ? null : "HRESULT " + hr };
}));

ipcMain.handle("endpoint:enable", ok(async (_e, ep) => {
  if (!ENDPOINT_RE.test(ep)) return { ok: false, error: "bad endpoint" };
  const hr = (await runPS(AUDIO_CS + `[Vox.Audio]::SetVisible(${psStr(ep)}, $true)`)).trim();
  return { ok: hr === "0", error: hr === "0" ? null : "HRESULT " + hr };
}));

// Game mode moves the Windows default output to VB-Cable; if the app quits while that is on, put it back.
let restoreEp = null;
ipcMain.handle("endpoint:restoreOnQuit", (_e, ep) => { restoreEp = ep && ENDPOINT_RE.test(ep) ? ep : null; });
app.on("will-quit", () => {
  if (!restoreEp) return;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", AUDIO_CS + `[Vox.Audio]::SetDefault(${psStr(restoreEp)})`],
      { windowsHide: true, timeout: 15000 });
  } catch (e) {}
});

const TOOLS = {
  devmgr: () => execFile("mmc.exe", ["devmgmt.msc"]),
  sound: () => execFile("control.exe", ["mmsys.cpl"]),
  update: () => shell.openExternal("ms-settings:windowsupdate-optionalupdates"),
  privacy: () => shell.openExternal("ms-settings:privacy-microphone")
};
ipcMain.handle("tool:open", (_e, name) => { if (TOOLS[name]) TOOLS[name](); });
ipcMain.handle("web:search", (_e, q) => shell.openExternal("https://www.google.com/search?q=" + encodeURIComponent(q + " driver")));
ipcMain.handle("app:info", () => ({ version: app.getVersion() }));
ipcMain.handle("web:open", (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

function registerHotkeys() {
  const send = a => win && win.webContents.send("hotkey", a);
  for (let i = 1; i <= 9; i++) globalShortcut.register(`Control+Alt+${i}`, () => send({ preset: i - 1 }));
  globalShortcut.register("Control+Alt+0", () => send({ preset: 9 }));
  globalShortcut.register("Control+Alt+B", () => send({ bypass: true }));
  globalShortcut.register("Control+Alt+M", () => send({ monitor: true }));
  globalShortcut.register("Control+Alt+R", () => send({ record: true }));
  globalShortcut.register("Control+Alt+H", () => send({ hear: true }));
  globalShortcut.register("Control+Alt+G", () => send({ game: true }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 820, minHeight: 600,
    backgroundColor: "#14171b", title: "VoxRack", icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.loadFile(path.join(__dirname, "app", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === "media" || perm === "speaker-selection"));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => perm === "media" || perm === "speaker-selection");
  createWindow();
  registerHotkeys();
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());

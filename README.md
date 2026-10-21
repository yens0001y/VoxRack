# VoxRack

Voice changer and audio toolkit for Windows (Electron).

- **Voice rack** – pitch, formant-style EQ, robot, reverb, echo and more, with presets and recording
- **Hear far mode** – amplifies room sound from the mic into headphones, with noise reduction and a volume ceiling
- **Game headphones** – stereo EQ for game audio (bass, footsteps, clarity, width, loudness) via VB-Audio Virtual Cable
- **Hardware & drivers** – scans audio devices and jacks, finds driver updates from Windows Update, installs .inf drivers, sets default devices

## Run from source

```
npm install
npm start
```

## Build the installer

```
npm run dist
```

Produces `dist/VoxRack-Setup-<version>.exe` and `dist/VoxRack-Portable-<version>.exe`.
If you build from the VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first.

import { type BackupV1, type BackupV2 } from "../src/backup.js";
import { type ProfileWriteV3, type ProfileWriteV4 } from "../src/profiles.js";

export function exampleBackup(): BackupV1 {
  return {
    schemaVersion: 1,
    preferences: {
      clock: { style: "digital", size: "large", hourCycle: "h23", showSeconds: false },
      sections: {
        clock: { visible: true, position: { x: 0.5, y: 0.2 } },
        shortcuts: { visible: true, position: { x: 0.5, y: 0.8 } },
        player: { visible: true, position: { x: 0.5, y: 0.5 } },
      },
      player: { selection: "local" },
    },
  };
}

export function exampleBackupV2(): BackupV2 {
  return {
    schemaVersion: 2,
    preferences: {
      clock: { style: "digital", sizePercent: 125 },
      positions: {
        clock: { x: 24, y: 80 },
        shortcuts: { x: 24, y: 240 },
        actions: null,
        music: { x: 24, y: 400 },
      },
      showShortcuts: true,
      musicPlayer: "local",
    },
  };
}

export function exampleProfile(name = "Daily drive"): ProfileWriteV3 {
  return {
    schemaVersion: 3,
    name,
    settings: {
      clock: { style: "digital", sizePercent: 112.5 },
      positions: { clock: { x: 24, y: 80 }, shortcuts: { x: 0, y: 240 }, actions: null, music: { x: 24, y: 400 } },
      showShortcuts: false,
      hideStatusBar: true,
      useSteeringWheelButtons: true,
      musicMode: "none",
      radio: { serverUrl: "https://radio.example.com/stream?station=jazz", autoplay: true, width: 360, height: 126 },
      spotify: {
        clientId: "0123456789abcdef0123456789abcdef",
        playbackUri: "spotify:playlist:0123456789abcdefghijAB",
        autoConnect: true,
        width: 360,
        height: 142,
        maxTitleLines: 2,
      },
      background: { type: "dark" },
    },
  };
}

export function exampleProfileV4(): ProfileWriteV4 {
  const { name, settings } = exampleProfile("Layout editor");
  return {
    schemaVersion: 4,
    name,
    settings: {
      ...settings,
      sectionSizes: { clock: null, shortcuts: { width: 320, height: 120 }, music: { width: 380, height: 140 } },
    },
  };
}

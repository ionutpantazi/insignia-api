import { type BackupV1, type BackupV2 } from "../src/backup.js";

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

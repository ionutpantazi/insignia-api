import { type Backup } from "../src/backup.js";

export function exampleBackup(): Backup {
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

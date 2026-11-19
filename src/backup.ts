import { Ajv } from "ajv";
import schema from "./schemas/settings-backup.v1.json" with { type: "json" };

export interface Section {
  visible: boolean;
  position: { x: number; y: number };
}

export interface Backup {
  schemaVersion: 1;
  preferences: {
    clock: {
      style: "digital" | "analog";
      size: "small" | "medium" | "large";
      hourCycle: "h12" | "h23";
      showSeconds: boolean;
    };
    sections: {
      clock: Section;
      shortcuts: Section;
      player: Section;
    };
    player: { selection: "local" | "spotify" | "radio" };
  };
}

export interface StoredBackup {
  backup: Backup;
  updatedAt: string;
}

export interface BackupStore {
  save(uid: string, backup: Backup): Promise<void>;
  get(uid: string): Promise<StoredBackup | null>;
}

const ajv = new Ajv({ allErrors: true, strict: true });
export const validateBackup = ajv.compile<Backup>(schema);

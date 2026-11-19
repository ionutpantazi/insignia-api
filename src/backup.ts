import { Ajv } from "ajv";
import schemaV1 from "./schemas/settings-backup.v1.json" with { type: "json" };
import schemaV2 from "./schemas/settings-backup.v2.json" with { type: "json" };

export interface Section {
  visible: boolean;
  position: { x: number; y: number };
}

export interface BackupV1 {
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

export type Position = { x: number; y: number } | null;

export interface BackupV2 {
  schemaVersion: 2;
  preferences: {
    clock: {
      style: "digital" | "analog";
      sizePercent: number;
    };
    positions: {
      clock: Position;
      shortcuts: Position;
      actions: Position;
      music: Position;
    };
    showShortcuts: boolean;
    musicPlayer: "none" | "local" | "spotify" | "radio";
  };
}

export type Backup = BackupV1 | BackupV2;

export interface StoredBackup {
  backup: Backup;
  updatedAt: string;
}

export interface BackupStore {
  save(uid: string, backup: Backup): Promise<void>;
  get(uid: string): Promise<StoredBackup | null>;
}

const ajv = new Ajv({ allErrors: true, strict: true });
export const backupValidators = {
  1: ajv.compile<BackupV1>(schemaV1),
  2: ajv.compile<BackupV2>(schemaV2),
};

export function validateBackup(value: unknown): value is Backup {
  return backupValidators[1](value) || backupValidators[2](value);
}

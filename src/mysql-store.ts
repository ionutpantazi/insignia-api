import { type Pool, type RowDataPacket } from "mysql2/promise";
import { type Backup, type BackupStore, type StoredBackup } from "./backup.js";
import { validateBackup } from "./backup.js";

interface BackupRow extends RowDataPacket {
  payload: unknown;
  updated_at: Date;
}

export class MysqlBackupStore implements BackupStore {
  constructor(private readonly pool: Pool) {}

  async save(uid: string, backup: Backup): Promise<void> {
    const payload = JSON.stringify(backup);
    await this.pool.execute(
      `INSERT INTO settings_backups (firebase_uid, payload, updated_at)
       VALUES (?, ?, UTC_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE payload = ?, updated_at = UTC_TIMESTAMP(3)`,
      [Buffer.from(uid, "utf8"), payload, payload],
    );
  }

  async get(uid: string): Promise<StoredBackup | null> {
    const [rows] = await this.pool.execute<BackupRow[]>(
      "SELECT payload, updated_at FROM settings_backups WHERE firebase_uid = ?",
      [Buffer.from(uid, "utf8")],
    );
    const row = rows[0];
    if (!row) return null;
    if (!validateBackup(row.payload)) {
      throw new Error("Stored backup failed schema validation.");
    }
    return { backup: row.payload, updatedAt: row.updated_at.toISOString() };
  }
}

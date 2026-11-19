import { type Pool, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";
import { type ProfileStore, type ProfileWrite, profilePageSize } from "./profiles.js";

interface ProfileListRow extends RowDataPacket {
  profile_id: string;
  name: string;
  updated_at: Date;
}

interface ProfileRow extends RowDataPacket {
  payload: unknown;
  updated_at: Date;
}

export class MysqlProfileStore implements ProfileStore {
  constructor(private readonly pool: Pool) {}

  async list(uid: string, after: string) {
    const [rows] = await this.pool.execute<ProfileListRow[]>(
      `SELECT profile_id, name, updated_at FROM settings_profiles
       WHERE firebase_uid = ? AND profile_id > ? AND payload->>'$.schemaVersion' = '5'
       ORDER BY profile_id LIMIT ${profilePageSize + 1}`,
      [Buffer.from(uid, "utf8"), after],
    );
    return rows.map((row) => ({ id: row.profile_id, name: row.name, updatedAt: row.updated_at.toISOString() }));
  }

  async get(uid: string, id: string) {
    const [rows] = await this.pool.execute<ProfileRow[]>(
      `SELECT payload, updated_at FROM settings_profiles
       WHERE firebase_uid = ? AND profile_id = ? AND payload->>'$.schemaVersion' = '5'`,
      [Buffer.from(uid, "utf8"), id],
    );
    const row = rows[0];
    return row ? { payload: row.payload, updatedAt: row.updated_at.toISOString() } : null;
  }

  async create(uid: string, id: string, profile: ProfileWrite, updatedAt: Date) {
    await this.pool.execute(
      "INSERT INTO settings_profiles (firebase_uid, profile_id, name, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
      [Buffer.from(uid, "utf8"), id, profile.name, JSON.stringify(profile), updatedAt],
    );
  }

  async overwrite(uid: string, id: string, profile: ProfileWrite, updatedAt: Date) {
    const [result] = await this.pool.execute<ResultSetHeader>(
      `UPDATE settings_profiles SET name = ?, payload = ?, updated_at = ?
       WHERE firebase_uid = ? AND profile_id = ? AND payload->>'$.schemaVersion' = '5'`,
      [profile.name, JSON.stringify(profile), updatedAt, Buffer.from(uid, "utf8"), id],
    );
    // mysql2 enables FOUND_ROWS by default, including identical writes in the same millisecond.
    return result.affectedRows === 1;
  }
}

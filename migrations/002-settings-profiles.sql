CREATE TABLE IF NOT EXISTS settings_profiles (
  firebase_uid VARBINARY(512) NOT NULL,
  profile_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name VARCHAR(80) CHARACTER SET utf8mb4 NOT NULL,
  payload JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (firebase_uid, profile_id)
) ENGINE=InnoDB;

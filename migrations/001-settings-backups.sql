CREATE TABLE IF NOT EXISTS settings_backups (
  firebase_uid VARBINARY(512) NOT NULL,
  payload JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (firebase_uid)
) ENGINE=InnoDB;

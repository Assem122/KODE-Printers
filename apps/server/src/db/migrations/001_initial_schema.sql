-- KODE Printer — initial schema
-- Implements the target data model in KODE-TECH-0005 §B4, with the corrections
-- the club's actual estate requires.
--
-- Two deliberate departures from §B4, both recorded in docs/adr:
--   1. `printers.floor` is not created. Every KODE building is single-storey, so
--      the column would be a guaranteed NULL that no report could group by.
--      `area` replaces it and holds what people actually say: "Reception".
--   2. Additional tables exist for the scan hub, templates, quotas, push
--      subscriptions and runtime settings, which §B4 does not cover because the
--      document scopes the backend only (DEC-08).
--
-- Migrations are forward-only and idempotent. §B19.5: any release containing a
-- destructive migration MUST say so in its release note, and there SHOULD NOT
-- be one.

-- ---------------------------------------------------------------- extensions

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive usernames

-- --------------------------------------------------------------------- zones

CREATE TABLE IF NOT EXISTS zones (
  id         SERIAL PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,   -- e.g. RECEP, ADMIN, POOL, ACAD
  label      TEXT NOT NULL UNIQUE,   -- e.g. "Reception", "Pool Area"
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE zones IS
  'One row per area/zone. code is the short token used in reports: RECEP, POOL.';

-- ---------------------------------------------------------------- collectors

CREATE TABLE IF NOT EXISTS collectors (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL UNIQUE,
  zone_id       INTEGER     REFERENCES zones(id) ON DELETE RESTRICT,
  -- Stored hashed and displayed exactly once, at creation. INV-08.
  api_key_hash  TEXT        NOT NULL,
  api_key_prefix TEXT       NOT NULL,
  version       TEXT,
  last_seen_at  TIMESTAMPTZ,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS collectors_zone_idx ON collectors (zone_id) WHERE is_active;

-- ------------------------------------------------------------------ printers

CREATE TABLE IF NOT EXISTS printers (
  id                      SERIAL PRIMARY KEY,
  zone_id                 INTEGER REFERENCES zones(id) ON DELETE RESTRICT,
  collector_id            INTEGER REFERENCES collectors(id) ON DELETE SET NULL,
  name                    TEXT        NOT NULL,

  -- Identity anchor. ADR-006: a DHCP lease change must not split the audit trail.
  serial_number           TEXT,
  mac_address             MACADDR,
  hostname                TEXT,
  ip_address              INET        NOT NULL,

  -- Where it physically is. No `floor` column: see the header note.
  area                    TEXT,
  vendor                  TEXT,
  model                   TEXT,

  transport               TEXT        NOT NULL DEFAULT 'auto'
                            CHECK (transport IN ('auto','ipp','raw9100')),
  ipp_uri                 TEXT,
  capabilities            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  capabilities_probed_at  TIMESTAMPTZ,

  snmp_version            TEXT        NOT NULL DEFAULT '2c'
                            CHECK (snmp_version IN ('1','2c','3','disabled')),
  -- Secrets. Never selected by any read path that reaches an API response.
  snmp_community          TEXT,
  snmp_username           TEXT,
  snmp_auth_key           TEXT,
  snmp_priv_key           TEXT,
  snmp_page_oid           TEXT        NOT NULL
                            DEFAULT '1.3.6.1.2.1.43.10.2.1.4.1.1',
  -- Vendor print/copy counters. Their absence is why job_type can be 'unknown'.
  snmp_print_oid          TEXT,
  snmp_copy_oid           TEXT,

  last_page_count         BIGINT,
  last_page_count_at      TIMESTAMPTZ,
  last_print_count        BIGINT,
  last_copy_count         BIGINT,

  scan_folder             TEXT,

  status                  TEXT        NOT NULL DEFAULT 'unknown'
                            CHECK (status IN ('online','offline','degraded','unknown')),
  state_reasons           TEXT[]      NOT NULL DEFAULT '{}',
  consecutive_failures    INTEGER     NOT NULL DEFAULT 0,
  last_checked_at         TIMESTAMPTZ,
  -- Set by the transport circuit breaker; cleared on the next success.
  circuit_open_until      TIMESTAMPTZ,

  is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  -- Operator maintenance flag: finish what is queued, accept nothing new.
  is_draining             BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Per-device ceiling on a single job. NULL uses the global setting.
  max_job_impressions     INTEGER     CHECK (max_job_impressions IS NULL OR max_job_impressions > 0),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Identity is the serial where one exists.
CREATE UNIQUE INDEX IF NOT EXISTS printers_serial_uq
  ON printers (serial_number) WHERE serial_number IS NOT NULL;

-- An address is unique only among *active* printers: a decommissioned device
-- must not block reuse of its address, which the delivered schema's plain
-- UNIQUE constraint did.
CREATE UNIQUE INDEX IF NOT EXISTS printers_ip_active_uq
  ON printers (ip_address) WHERE is_active;

CREATE INDEX IF NOT EXISTS printers_zone_idx ON printers (zone_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS printers_collector_idx ON printers (collector_id) WHERE is_active;

-- --------------------------------------------------------- printer supplies

CREATE TABLE IF NOT EXISTS printer_supplies (
  id            SERIAL PRIMARY KEY,
  printer_id    INTEGER     NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  supply_index  INTEGER     NOT NULL,
  name          TEXT        NOT NULL,
  colorant      TEXT,
  level         BIGINT,
  max_level     BIGINT,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (printer_id, supply_index)
);

-- Consumption history, used for the days-to-empty forecast. Retained short:
-- a linear fit over two weeks is as good as one over two years, and cheaper.
CREATE TABLE IF NOT EXISTS printer_supply_history (
  id            BIGSERIAL PRIMARY KEY,
  printer_id    INTEGER     NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  supply_index  INTEGER     NOT NULL,
  percent       NUMERIC(5,2) NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supply_history_lookup_idx
  ON printer_supply_history (printer_id, supply_index, observed_at DESC);

-- --------------------------------------------------------------------- users

CREATE TABLE IF NOT EXISTS users (
  id                   SERIAL PRIMARY KEY,
  username             CITEXT      NOT NULL UNIQUE,
  email                CITEXT,
  display_name         TEXT,
  password_hash        TEXT,
  -- 'local' today; an AD/LDAP provider id once that is wired in. Rows from an
  -- external provider carry no password_hash at all.
  auth_provider        TEXT        NOT NULL DEFAULT 'local',
  external_id          TEXT,
  role                 TEXT        NOT NULL CHECK (role IN ('admin','user')),
  -- Reporting only. INV-01: this MUST NOT influence access.
  department           TEXT,
  -- Reporting/default-printer-picker hint only. Same INV-01 guarantee as
  -- department: this MUST NOT influence access or what a user is permitted
  -- to print to.
  zone_id              INTEGER     REFERENCES zones(id) ON DELETE SET NULL,
  must_change_password BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_login_count   INTEGER     NOT NULL DEFAULT 0,
  first_failed_login_at TIMESTAMPTZ,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  -- The walk-up job owner. Not loggable-in, so every job row has a stable,
  -- non-impersonatable actor.
  is_system            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_local_needs_hash
    CHECK (auth_provider <> 'local' OR is_system OR password_hash IS NOT NULL),
  CONSTRAINT users_system_not_loginable
    CHECK (NOT is_system OR NOT is_active)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_external_uq
  ON users (auth_provider, external_id) WHERE external_id IS NOT NULL;

-- ------------------------------------------------------------- user_printers

-- The single source of truth for access. INV-01.
-- The cascade is intentional: a grant has no meaning once either side is gone,
-- and the record of who granted it survives in audit_log.
CREATE TABLE IF NOT EXISTS user_printers (
  user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  printer_id  INTEGER NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  granted_by  INTEGER          REFERENCES users(id)    ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Temporary access for contractors and event staff. NULL means permanent.
  expires_at  TIMESTAMPTZ,
  PRIMARY KEY (user_id, printer_id)
);

CREATE INDEX IF NOT EXISTS user_printers_printer_idx ON user_printers (printer_id);

-- ---------------------------------------------------------------------- jobs

CREATE TABLE IF NOT EXISTS jobs (
  id                     BIGSERIAL PRIMARY KEY,
  -- ON DELETE RESTRICT is the schema-level enforcement of INV-05. The delivered
  -- build blocked hard deletion in the model layer only, which one bypassing
  -- route would defeat.
  printer_id             INTEGER REFERENCES printers(id) ON DELETE RESTRICT,
  zone_id                INTEGER REFERENCES zones(id)    ON DELETE SET NULL,
  user_id                INTEGER REFERENCES users(id)    ON DELETE SET NULL,

  -- INV-06: the record stays readable after the user or printer record changes.
  username_snapshot      TEXT        NOT NULL,
  printer_name_snapshot  TEXT        NOT NULL,

  source                 TEXT        NOT NULL
                           CHECK (source IN ('app','walkup','manual')),
  job_type               TEXT        NOT NULL
                           CHECK (job_type IN ('print','scan','copy','fax','unknown')),
  status                 TEXT        NOT NULL
                           CHECK (status IN ('queued','held','processing','sent',
                                             'completed','failed','cancelled')),

  pages                  INTEGER     NOT NULL DEFAULT 0,
  copies                 INTEGER     NOT NULL DEFAULT 1,
  -- What the print engine will mark. The ledger in §B8.3 depends on it.
  impressions            INTEGER,
  color_mode             TEXT CHECK (color_mode IN ('color','grayscale')),
  duplex                 BOOLEAN,

  document_name          TEXT,
  file_path              TEXT,
  file_hash              TEXT,
  -- True when the count came from the unreliable byte-scan fallback. These
  -- numbers feed reports, so an estimate must be visible as one. §B10.3.
  page_count_estimated   BOOLEAN     NOT NULL DEFAULT FALSE,

  print_options          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  transport_used         TEXT CHECK (transport_used IN ('ipp','raw9100')),
  ipp_job_uri            TEXT,

  attempts               INTEGER     NOT NULL DEFAULT 0,
  max_attempts           INTEGER     NOT NULL DEFAULT 3,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by              TEXT,
  locked_at              TIMESTAMPTZ,

  error_code             TEXT,
  notes                  TEXT,
  request_id             TEXT,
  -- Hold-and-release: set when the user releases the job at the device.
  released_at            TIMESTAMPTZ,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at           TIMESTAMPTZ,

  CONSTRAINT jobs_positive_counts CHECK (pages >= 0 AND copies >= 1),
  CONSTRAINT jobs_attempts_bounded CHECK (attempts >= 0 AND attempts <= max_attempts + 1)
);

-- The dequeue index. Partial, because only queued rows are ever scanned for.
CREATE INDEX IF NOT EXISTS jobs_queue_idx
  ON jobs (next_attempt_at, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_stuck_idx
  ON jobs (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS jobs_printer_created_idx ON jobs (printer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_user_created_idx    ON jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_created_idx         ON jobs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS jobs_zone_created_idx    ON jobs (zone_id, created_at DESC);
-- Supports the 60-second duplicate-submission check in §B10.5.
CREATE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON jobs (user_id, printer_id, file_hash, created_at DESC)
  WHERE file_hash IS NOT NULL;

-- --------------------------------------------------------- walk-up ledger

-- The outstanding-impression ledger, ADR-008.
--
-- Persisted rather than held in memory precisely because the alternative loses
-- attribution across a restart: every in-flight app job would reappear as a
-- fabricated walk-up the moment its impressions landed.
CREATE TABLE IF NOT EXISTS impression_ledger (
  id                     BIGSERIAL PRIMARY KEY,
  printer_id             INTEGER     NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  job_id                 BIGINT      NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  outstanding            INTEGER     NOT NULL CHECK (outstanding >= 0),
  -- Generous, and capped. Its only job is to stop a failed send from absorbing
  -- a later genuine walk-up; it is not a guess at how long printing takes.
  expires_at             TIMESTAMPTZ NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_printer_idx
  ON impression_ledger (printer_id, created_at);
CREATE INDEX IF NOT EXISTS ledger_expiry_idx ON impression_ledger (expires_at);

-- --------------------------------------------------------------------- scans

CREATE TABLE IF NOT EXISTS scans (
  id                    BIGSERIAL PRIMARY KEY,
  printer_id            INTEGER REFERENCES printers(id) ON DELETE SET NULL,
  printer_name_snapshot TEXT        NOT NULL,
  zone_id               INTEGER REFERENCES zones(id) ON DELETE SET NULL,
  user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username_snapshot     TEXT,
  status                TEXT        NOT NULL DEFAULT 'unclaimed'
                          CHECK (status IN ('unclaimed','claimed','archived')),
  original_filename     TEXT        NOT NULL,
  stored_filename       TEXT        NOT NULL UNIQUE,
  size_bytes            BIGINT      NOT NULL,
  page_count            INTEGER,
  content_type          TEXT        NOT NULL DEFAULT 'application/octet-stream',
  file_hash             TEXT,
  claimed_via           TEXT CHECK (claimed_via IN ('reservation','manual')),
  scanned_at            TIMESTAMPTZ NOT NULL,
  claimed_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- §B9.2: dedupe on the tuple, not the filename alone, because many MFPs
  -- restart their filename sequence after a reboot.
  UNIQUE (printer_id, original_filename, size_bytes, scanned_at)
);

CREATE INDEX IF NOT EXISTS scans_user_idx    ON scans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_printer_idx ON scans (printer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_created_idx ON scans (created_at DESC, id DESC);

-- Scan-to-me. A user declares intent at a printer; the next arriving scan from
-- that device inside the window is assigned to them.
CREATE TABLE IF NOT EXISTS scan_reservations (
  id          BIGSERIAL PRIMARY KEY,
  printer_id  INTEGER     NOT NULL REFERENCES printers(id) ON DELETE CASCADE,
  user_id     INTEGER     NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live reservation per printer: two people claiming the same device at once
-- cannot be disambiguated from a folder drop, so the second must be refused
-- rather than guessed at.
CREATE UNIQUE INDEX IF NOT EXISTS scan_reservation_active_uq
  ON scan_reservations (printer_id) WHERE consumed_at IS NULL;

-- ------------------------------------------------------------- notifications

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT        NOT NULL,
  severity    TEXT        NOT NULL CHECK (severity IN ('info','warning','critical')),
  printer_id  INTEGER     REFERENCES printers(id) ON DELETE SET NULL,
  job_id      BIGINT      REFERENCES jobs(id)     ON DELETE SET NULL,
  -- Set for user-directed notifications (job done, scan claimed). NULL means
  -- it is an operational notification for admins.
  user_id     INTEGER     REFERENCES users(id)    ON DELETE CASCADE,
  message     TEXT        NOT NULL,
  payload     JSONB,
  -- Collapses repeats: "printer offline" every 15s should update one row, not
  -- create ninety.
  dedupe_key  TEXT,
  occurrences INTEGER     NOT NULL DEFAULT 1,
  last_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_uq
  ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id BIGINT      NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         INTEGER     NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL UNIQUE,
  p256dh      TEXT        NOT NULL,
  auth        TEXT        NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- ----------------------------------------------------------------- audit_log

-- Append-only. No UPDATE or DELETE path exists in the application, and the
-- revoke below removes the ability to add one by accident.
CREATE TABLE IF NOT EXISTS audit_log (
  id              BIGSERIAL PRIMARY KEY,
  actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username  TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,
  entity_id       TEXT,
  before          JSONB,
  after           JSONB,
  ip_address      INET,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_entity_idx  ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx   ON audit_log (actor_user_id, created_at DESC);

-- -------------------------------------------------------------- refresh_tokens

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What makes reuse detection actionable rather than merely observable: on
  -- reuse the whole family is revoked, not just the presented token. §B12.3.
  family_id   UUID        NOT NULL,
  token_hash  TEXT        NOT NULL UNIQUE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by BIGINT      REFERENCES refresh_tokens(id) ON DELETE SET NULL,
  user_agent  TEXT,
  ip_address  INET
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- -------------------------------------------------------------------- quotas

CREATE TABLE IF NOT EXISTS quotas (
  id          SERIAL PRIMARY KEY,
  scope       TEXT    NOT NULL CHECK (scope IN ('user','department','site')),
  scope_ref   TEXT    NOT NULL,
  period      TEXT    NOT NULL CHECK (period IN ('daily','weekly','monthly')),
  page_limit  INTEGER NOT NULL CHECK (page_limit > 0),
  -- DEC-05: ships FALSE everywhere. Reporting first, so the club can see
  -- consumption before deciding to restrict it.
  enforce     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_ref, period)
);

-- ----------------------------------------------------------------- templates

CREATE TABLE IF NOT EXISTS print_templates (
  id                SERIAL PRIMARY KEY,
  name              TEXT        NOT NULL,
  description       TEXT,
  stored_filename   TEXT        NOT NULL,
  original_filename TEXT        NOT NULL,
  file_hash         TEXT,
  page_count        INTEGER,
  default_options   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  zone_id           INTEGER     REFERENCES zones(id) ON DELETE SET NULL,
  created_by        INTEGER     REFERENCES users(id) ON DELETE SET NULL,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  times_used        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name)
);

-- ------------------------------------------------------------------ settings

-- Single-row table. A row-count constraint beats a key/value bag here: the
-- settings are a fixed, typed set, and a bag makes every read a cast.
CREATE TABLE IF NOT EXISTS app_settings (
  id                          BOOLEAN PRIMARY KEY DEFAULT TRUE,
  upload_retention_days       INTEGER NOT NULL DEFAULT 30 CHECK (upload_retention_days >= 0),
  scan_retention_days         INTEGER NOT NULL DEFAULT 90 CHECK (scan_retention_days > 0),
  notification_retention_days INTEGER NOT NULL DEFAULT 180 CHECK (notification_retention_days > 0),
  quota_enforcement_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  max_job_impressions         INTEGER NOT NULL DEFAULT 2000 CHECK (max_job_impressions > 0),
  large_job_warn_impressions  INTEGER NOT NULL DEFAULT 100 CHECK (large_job_warn_impressions > 0),
  max_concurrent_jobs_per_printer INTEGER NOT NULL DEFAULT 1
                              CHECK (max_concurrent_jobs_per_printer > 0),
  printer_cooldown_seconds    INTEGER NOT NULL DEFAULT 2 CHECK (printer_cooldown_seconds >= 0),
  cost_per_page_mono          NUMERIC(8,4) NOT NULL DEFAULT 0.0150,
  cost_per_page_color         NUMERIC(8,4) NOT NULL DEFAULT 0.1200,
  currency                    TEXT    NOT NULL DEFAULT 'EGP',
  co2_grams_per_impression    NUMERIC(8,3) NOT NULL DEFAULT 4.500,
  email_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  web_push_enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  scan_reservation_minutes    INTEGER NOT NULL DEFAULT 5 CHECK (scan_reservation_minutes > 0),
  -- DEC-06. Until vendor print/copy counters land, walk-up totals are not
  -- prints and MUST NOT be labelled as such.
  walkup_report_label         TEXT    NOT NULL DEFAULT 'Device activity',
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT app_settings_single_row CHECK (id),
  CONSTRAINT app_settings_warn_below_max CHECK (large_job_warn_impressions <= max_job_impressions)
);

INSERT INTO app_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------- collector events

-- Idempotency ledger for collector replay. §B11.4: events carry a
-- collector-generated key so a replay after a dropped uplink cannot double-log.
CREATE TABLE IF NOT EXISTS collector_event_keys (
  idempotency_key TEXT        PRIMARY KEY,
  collector_id    INTEGER     NOT NULL REFERENCES collectors(id) ON DELETE CASCADE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS collector_event_keys_received_idx
  ON collector_event_keys (received_at);

-- ------------------------------------------------------------- housekeeping

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['zones','printers','users','quotas','print_templates']
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I', 'touch_' || target || '_updated_at', target);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      'touch_' || target || '_updated_at', target);
  END LOOP;
END $$;

-- INV-07 relies on the application always writing an audit row inside the
-- change's transaction. This trigger is the backstop for the *other* half of
-- the invariant: that nothing ever rewrites history after the fact.
CREATE OR REPLACE FUNCTION audit_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

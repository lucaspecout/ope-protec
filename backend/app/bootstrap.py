from sqlalchemy import text
from sqlalchemy.engine import Engine

SCHEMA_BOOTSTRAP_STATEMENTS = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS municipality_name VARCHAR(120)",
    "ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS internal_mail_group VARCHAR(255)",
    "ALTER TABLE weather_alerts ADD COLUMN IF NOT EXISTS sent_to_internal_group BOOLEAN DEFAULT FALSE",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS contacts TEXT",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS insee_code VARCHAR(5)",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS postal_code VARCHAR(10)",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS additional_info TEXT",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS population INTEGER",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS shelter_capacity INTEGER",
    "ALTER TABLE municipalities ADD COLUMN IF NOT EXISTS radio_channel VARCHAR(80)",
    "ALTER TABLE river_stations ADD COLUMN IF NOT EXISTS is_priority BOOLEAN DEFAULT FALSE",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS municipality_id INTEGER REFERENCES municipalities(id)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS danger_level VARCHAR(20) DEFAULT 'vert'",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS danger_emoji VARCHAR(8) DEFAULT '🟢'",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS target_scope VARCHAR(20) DEFAULT 'departemental'",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'nouveau'",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS event_time TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS location VARCHAR(160)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS source VARCHAR(120)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS actions_taken TEXT",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS next_update_due TIMESTAMP WITHOUT TIME ZONE",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(120)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS assigned_role VARCHAR(40)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS tags VARCHAR(255)",
    "ALTER TABLE operational_logs ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES incident_events(id)",
    """
    CREATE TABLE IF NOT EXISTS incident_events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(180) NOT NULL,
        address VARCHAR(220) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ouvert',
        municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_by_id INTEGER NOT NULL REFERENCES users(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS municipality_documents (
        id SERIAL PRIMARY KEY,
        municipality_id INTEGER NOT NULL REFERENCES municipalities(id) ON DELETE CASCADE,
        doc_type VARCHAR(40) NOT NULL DEFAULT 'annexe',
        title VARCHAR(160) NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        uploaded_by_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_municipality_documents_municipality ON municipality_documents(municipality_id)",
    """
    CREATE TABLE IF NOT EXISTS map_points (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        category VARCHAR(40) NOT NULL DEFAULT 'autre',
        icon VARCHAR(16) NOT NULL DEFAULT '📍',
        notes TEXT,
        lat DOUBLE PRECISION NOT NULL,
        lon DOUBLE PRECISION NOT NULL,
        municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
        created_by_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "ALTER TABLE map_points ADD COLUMN IF NOT EXISTS icon_url VARCHAR(512)",
    "CREATE INDEX IF NOT EXISTS idx_weather_alerts_created_at ON weather_alerts(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_river_stations_updated_at ON river_stations(updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_operational_logs_created_at ON operational_logs(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_operational_logs_municipality_created_at ON operational_logs(municipality_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_operational_logs_event_created_at ON operational_logs(event_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_incident_events_created_at ON incident_events(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_municipality_documents_created_at ON municipality_documents(created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_municipalities_crisis_mode ON municipalities(crisis_mode)",
    "CREATE INDEX IF NOT EXISTS idx_municipalities_pcs_active ON municipalities(pcs_active)",
    """
    CREATE TABLE IF NOT EXISTS map_annotations (
        id SERIAL PRIMARY KEY,
        annotation_type VARCHAR(24) NOT NULL DEFAULT 'polygon',
        geojson TEXT NOT NULL,
        text_label VARCHAR(180),
        color VARCHAR(16) NOT NULL DEFAULT '#d7263d',
        weight INTEGER NOT NULL DEFAULT 3,
        fill_opacity DOUBLE PRECISION NOT NULL DEFAULT 0.18,
        municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
        created_by_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS scenario_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        hazard_type VARCHAR(40) NOT NULL DEFAULT 'multi',
        severity VARCHAR(20) NOT NULL DEFAULT 'jaune',
        description TEXT NOT NULL DEFAULT '',
        default_checklist TEXT NOT NULL DEFAULT '[]',
        reflex_sheet_template TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS exercise_runs (
        id SERIAL PRIMARY KEY,
        scenario_id INTEGER NOT NULL REFERENCES scenario_templates(id) ON DELETE CASCADE,
        municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
        mode VARCHAR(20) NOT NULL DEFAULT 'exercice',
        status VARCHAR(20) NOT NULL DEFAULT 'planifie',
        score_preparedness INTEGER NOT NULL DEFAULT 0,
        started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP WITHOUT TIME ZONE,
        created_by_id INTEGER NOT NULL REFERENCES users(id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pcs_guidance_runs (
        id SERIAL PRIMARY KEY,
        municipality_id INTEGER REFERENCES municipalities(id) ON DELETE SET NULL,
        hazard_type VARCHAR(40) NOT NULL,
        alert_level VARCHAR(20) NOT NULL DEFAULT 'jaune',
        recommended_level VARCHAR(20) NOT NULL DEFAULT 'veille',
        current_step VARCHAR(120) NOT NULL DEFAULT 'qualification',
        checklist_json TEXT NOT NULL DEFAULT '[]',
        reflex_sheet_text TEXT NOT NULL DEFAULT '',
        triggered_by_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_exercise_runs_started_at ON exercise_runs(started_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_pcs_guidance_runs_created_at ON pcs_guidance_runs(created_at DESC)",
]


def bootstrap_database_schema(engine: Engine) -> None:
    with engine.begin() as conn:
        for statement in SCHEMA_BOOTSTRAP_STATEMENTS:
            conn.execute(text(statement))

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_name VARCHAR(120) NOT NULL DEFAULT 'Dr. Adaobi Okafor (General Practice)',
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_slot_time_range CHECK (end_time > start_time),
    CONSTRAINT uq_doctor_slot_start UNIQUE (doctor_name, start_time)
);

CREATE INDEX IF NOT EXISTS idx_slots_availability_start
    ON slots (is_available, start_time ASC, id ASC);

CREATE TABLE IF NOT EXISTS bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
    patient_name VARCHAR(120) NOT NULL,
    patient_email VARCHAR(255) NOT NULL,
    patient_phone VARCHAR(40),
    reason VARCHAR(500),
    status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED'
        CHECK (status IN ('CONFIRMED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_unique_confirmed_slot
    ON bookings (slot_id)
    WHERE status = 'CONFIRMED';

CREATE INDEX IF NOT EXISTS idx_bookings_email_created_id
    ON bookings (LOWER(patient_email), created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_created_id
    ON bookings (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    client_scope VARCHAR(255) NOT NULL DEFAULT 'global',
    idempotency_key VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER,
    response_body JSONB,
    booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS'
        CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    PRIMARY KEY (client_scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
    ON idempotency_keys (expires_at);

INSERT INTO slots (id, doctor_name, start_time, end_time, is_available)
SELECT
    gen_random_uuid(),
    doctor,
    slot_start,
    slot_start + INTERVAL '30 minutes',
    TRUE
FROM (
    SELECT
        CASE
            WHEN gs % 3 = 0 THEN 'Dr. Adaobi Okafor (General Practice)'
            WHEN gs % 3 = 1 THEN 'Dr. Tunde Bakare (Internal Medicine)'
            ELSE 'Dr. Amina Yusuf (Family Medicine)'
        END AS doctor,
        DATE_TRUNC('hour', NOW() + INTERVAL '2 hours') + (gs * INTERVAL '1 hour') AS slot_start
    FROM generate_series(1, 24) AS gs
) AS seed
ON CONFLICT (doctor_name, start_time) DO NOTHING;
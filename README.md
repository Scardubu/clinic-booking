# 🏥 Koya Clinic — Patient Appointment Booking Platform

[![Patient Portal](https://img.shields.io/badge/Web%20Portal-Live-brightgreen.svg?logo=vercel)](https://clinic-booking-web-mu.vercel.app)
[![API Health](https://img.shields.io/badge/API%20Health-Healthy-emerald.svg)](https://clinic-booking-api-od9i.onrender.com/health)
[![Node.js](https://img.shields.io/badge/Node.js-v22+-339933.svg?logo=nodedotjs)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg?logo=typescript)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15+-336791.svg?logo=postgresql)](https://www.postgresql.org)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](LICENSE)

A high-concurrency, patient-first clinic booking system featuring an intuitive web portal and an enterprise-grade TypeScript/Express API. Engineered to deliver a frictionless experience for patients while guaranteeing database-enforced concurrency control, payload-aware idempotency, and intelligent anti-spam protection for healthcare providers.

---

## 🌐 Live Environments

| Service | Environment URL | Description | Status |
| :--- | :--- | :--- | :--- |
| **Patient Web Portal** | [clinic-booking-web-mu.vercel.app](https://clinic-booking-web-mu.vercel.app) | Responsive patient interface hosted on Vercel Edge | ![Live](https://img.shields.io/badge/status-active-brightgreen) |
| **Production API** | [clinic-booking-api-od9i.onrender.com](https://clinic-booking-api-od9i.onrender.com) | Production REST API backend hosted on Render | ![Live](https://img.shields.io/badge/status-active-brightgreen) |
| **Health Monitor** | [clinic-booking-api-od9i.onrender.com/health](https://clinic-booking-api-od9i.onrender.com/health) | Real-time health check & service uptime monitor | ![Healthy](https://img.shields.io/badge/uptime-100%25-emerald) |

> ℹ️ **Infrastructure Advisory (Render Cold Starts):**  
> The backend API is hosted on Render's free tier. Idle instances scale down after 15 minutes of inactivity. When awakening from an idle state, the initial request may take ~50 seconds to spin up. All subsequent requests respond with sub-second latency. The web portal features built-in loading states to guide users during cold starts.

---

## ✨ Consumer Features & Patient Experience

### 1. 📅 Real-Time Slot Discovery
- **Live Clinic Availability:** Browse upcoming appointment slots dynamically populated from clinic schedules.
- **Doctor Transparency:** Review physician names and clinical specializations (e.g., *Dr. Adaobi Okafor — General Practice*, *Dr. Tunde Bakare — Internal Medicine*, *Dr. Amina Yusuf — Family Medicine*) upfront.
- **Dynamic Slot States:** Distinct visual indicators for available slots vs. booked slots prevent accidental selection of unavailable times.
- **Provider Filtering:** Search for specific healthcare providers or specializations via API query parameters or web filters.

### 2. 📝 Frictionless Booking Workflow
- **Human-Readable Slot Cards:** Eliminates technical jargon and raw UUIDs in favor of clean physician and appointment time summaries.
- **Interactive Slot Selection:** Effortlessly switch between appointment slots with keyboard navigation (`Enter` / `Space`) and instant focus without layout shifts.
- **Guided Form Validation:** Real-time feedback for required fields (patient full name, valid email, phone number, and visit reason).
- **Change Slot Shortcut:** Need to pick a different time? Click `⇄ Change Slot` to instantly return to the calendar selection without losing your entered patient details.

### 3. 🧾 Consolidated Digital Receipt
- **Instant Booking Confirmation:** A single, high-contrast receipt card appears immediately upon reservation with physician details, appointment time, and patient information.
- **1-Click Reference ID Auto-Copy:** The unique Booking Reference ID is automatically copied to your clipboard upon confirmation, with an interactive copy button for convenience.
- **Quick Navigation:** Seamlessly jump to `View in My Bookings` to see your record in the patient history or click `Book Another Appointment` to reset the form cleanly.

### 4. 👥 Appointment Management & Self-Service
- **Email History Search:** Search and filter appointments by patient email address with friendly empty-state guidance and 1-click filter clearing.
- **Smooth Cursor Pagination:** Browse booking records chronologically with high-performance keyset cursor pagination (`First Page` / `Next Page`).
- **Instant Cancellation & Slot Recovery:** Cancel an appointment with a single click; the slot is instantly freed and returned to the pool of available appointments.
- **Reference ID Lookup:** Look up any existing appointment by Booking Reference ID to check status, verify appointment details, or cancel anytime.

---

## 🛡️ Architecture & Consumer Protections

```
   ┌─────────────────────────────────────────────────────────┐
   │             Patient Web Client (Vercel Edge)            │
   │  • Clean responsive UI    • 1-Click auto-copy           │
   │  • Human-readable summary • Zero client-side API keys   │
   └────────────────────────────┬────────────────────────────┘
                                │ HTTPS Requests
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │             Vercel Edge Serverless Proxy                │
   │  • Secure API Key injection  • Edge attack isolation    │
   │  • Administrative blocking  • Header forwarding         │
   └────────────────────────────┬────────────────────────────┘
                                │ Authenticated Requests
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │            Express API Backend (Render Engine)          │
   │  • OpenAPI 3.0.3 contract adherence                     │
   │  • Per-email sliding-window rate limiter (5 req/min)     │
   │  • Transaction-scoped advisory locking (anti-deadlock)  │
   └────────────────────────────┬────────────────────────────┘
                                │ Connection Pool (PgBouncer)
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │              PostgreSQL Database (Neon)                 │
   │  • Partial unique index on confirmed slots              │
   │  • Deterministic SHA-256 payload idempotency store      │
   │  • Atomic cancellation & instant slot recovery          │
   └─────────────────────────────────────────────────────────┘
```

| Protection | Consumer Benefit | Engineering Mechanism |
| :--- | :--- | :--- |
| **Zero Double-Bookings** | Prevents two patients from ever reserving the same appointment slot, even under concurrent traffic spikes. | Engine-level PostgreSQL partial unique index: `CREATE UNIQUE INDEX idx_bookings_unique_confirmed_slot ON bookings (slot_id) WHERE LOWER(status) = 'confirmed'`. Concurrent collisions yield `409 Conflict` instantly. |
| **Idempotent Replays** | Network drops or double-clicking the book button will never double-charge or create duplicate appointments. | SHA-256 canonical payload hashing with PostgreSQL transaction advisory locks (`pg_advisory_xact_lock`). Replayed requests return cached confirmations with `Idempotent-Replayed: true` without consuming rate-limit budgets. |
| **Spam & Bot Guardrails** | Protects appointment availability against scrapers and booking bots. | Sliding-window rate limiter allowing 5 attempts per email per minute with an exact `Retry-After` header on HTTP 429. |
| **Edge Privacy Shield** | Patient credentials, administrative API keys, and database tokens remain 100% confidential. | Vercel Edge Serverless proxy injects `X-API-Key` server-side while blocking administrative endpoints (`POST /reset`) from client access with `403 Forbidden`. |

---

## 🔌 API Reference Guide

All API requests require authentication via the `X-API-Key` header (or `Authorization: Bearer <key>`). The web portal automatically manages this via its secure edge proxy.

### Summary of Endpoints

| Method | Endpoint | Description | Public / Proxy |
| :--- | :--- | :--- | :--- |
| `GET` | `/slots` | List all clinic appointment slots with real-time availability | Allowed |
| `GET` | `/slots/:id` | Retrieve details for a specific appointment slot | Allowed |
| `POST` | `/bookings` | Create a confirmed patient appointment | Allowed |
| `GET` | `/bookings` | List patient bookings (supports email filter & cursor pagination) | Allowed |
| `GET` | `/bookings/:id` | Look up a single booking by its Reference ID | Allowed |
| `DELETE` | `/bookings/:id` | Cancel an appointment and immediately free its slot | Allowed |
| `POST` | `/bookings/:id/cancel` | Alias to cancel an appointment (POST alternative) | Allowed |
| `GET` | `/health` | Check service health and uptime status (No API key needed) | Public |
| `POST` | `/reset` | Purge database and re-seed default demo slots (Admin only) | Edge-Blocked |

---

### Detailed Endpoint Examples

#### 1. Retrieve Available Appointment Slots
Filter appointment slots by availability or provider name.

```bash
# Get only open/available slots
curl -X GET "https://clinic-booking-api-od9i.onrender.com/slots?available=true" \
  -H "X-API-Key: your_api_key_here"

# Or filter by doctor name / specialty
curl -X GET "https://clinic-booking-api-od9i.onrender.com/slots?available=true&provider=Adaobi" \
  -H "X-API-Key: your_api_key_here"
```

**Response (200 OK):**
```json
{
  "slots": [
    {
      "id": "0a954bbf-63e1-4058-b747-52af500b6d30",
      "provider": "Dr. Adaobi Okafor (General Practice)",
      "doctor_name": "Dr. Adaobi Okafor (General Practice)",
      "start_time": "2026-11-01T09:00:00.000Z",
      "end_time": "2026-11-01T09:30:00.000Z",
      "is_available": true
    }
  ],
  "count": 1
}
```

#### 2. Retrieve Specific Slot Details
```bash
curl -X GET "https://clinic-booking-api-od9i.onrender.com/slots/0a954bbf-63e1-4058-b747-52af500b6d30" \
  -H "X-API-Key: your_api_key_here"
```

**Response (200 OK):**
```json
{
  "id": "0a954bbf-63e1-4058-b747-52af500b6d30",
  "provider": "Dr. Adaobi Okafor (General Practice)",
  "doctor_name": "Dr. Adaobi Okafor (General Practice)",
  "start_time": "2026-11-01T09:00:00.000Z",
  "end_time": "2026-11-01T09:30:00.000Z",
  "is_available": true
}
```

#### 3. Create an Appointment Booking
Include a unique `Idempotency-Key` header to protect against accidental retries or network interruptions.

```bash
curl -X POST "https://clinic-booking-api-od9i.onrender.com/bookings" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your_api_key_here" \
  -H "Idempotency-Key: c9d8e7a6-b5c4-4d3e-2f1a-0b9c8d7e6f5a" \
  -d '{
    "slot_id": "0a954bbf-63e1-4058-b747-52af500b6d30",
    "name": "Adaeze Nwosu",
    "email": "adaeze@example.com",
    "phone": "+234 803 123 4567",
    "reason": "Annual Wellness Checkup"
  }'
```

**Response (201 Created):**
```json
{
  "id": "b3e21a4f-5678-4901-abcd-ef0123456789",
  "slot_id": "0a954bbf-63e1-4058-b747-52af500b6d30",
  "name": "Adaeze Nwosu",
  "email": "adaeze@example.com",
  "phone": "+234 803 123 4567",
  "reason": "Annual Wellness Checkup",
  "status": "confirmed",
  "created_at": "2026-10-30T08:30:00.000Z",
  "slot": {
    "id": "0a954bbf-63e1-4058-b747-52af500b6d30",
    "provider": "Dr. Adaobi Okafor (General Practice)",
    "start_time": "2026-11-01T09:00:00.000Z",
    "end_time": "2026-11-01T09:30:00.000Z"
  }
}
```

#### 4. List Patient Bookings & Keyset Cursor Pagination
Query bookings filtered by patient email, booking status (`confirmed` / `cancelled`), and navigate pages using keyset cursor pagination.

```bash
# Fetch first page with limit=10
curl -X GET "https://clinic-booking-api-od9i.onrender.com/bookings?email=adaeze@example.com&limit=10" \
  -H "X-API-Key: your_api_key_here"

# Fetch subsequent page using next_cursor
curl -X GET "https://clinic-booking-api-od9i.onrender.com/bookings?email=adaeze@example.com&limit=10&cursor=eyJjcmVhdGVkX2F0IjoiMjAyNi0xMC0zMFQwODozMDowMC4wMDBaIiwiaWQiOiJiM2UyMWE0Zi..." \
  -H "X-API-Key: your_api_key_here"
```

**Response (200 OK):**
```json
{
  "bookings": [
    {
      "id": "b3e21a4f-5678-4901-abcd-ef0123456789",
      "slot_id": "0a954bbf-63e1-4058-b747-52af500b6d30",
      "name": "Adaeze Nwosu",
      "email": "adaeze@example.com",
      "phone": "+234 803 123 4567",
      "reason": "Annual Wellness Checkup",
      "status": "confirmed",
      "created_at": "2026-10-30T08:30:00.000Z"
    }
  ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0xMC0zMFQwODozMDowMC4wMDBaIiwiaWQiOiJiM2UyMWE0Zi...",
  "total": 1,
  "limit": 10,
  "has_more": false
}
```

#### 5. Retrieve Specific Booking by Reference ID
```bash
curl -X GET "https://clinic-booking-api-od9i.onrender.com/bookings/b3e21a4f-5678-4901-abcd-ef0123456789" \
  -H "X-API-Key: your_api_key_here"
```

**Response (200 OK):**
```json
{
  "id": "b3e21a4f-5678-4901-abcd-ef0123456789",
  "slot_id": "0a954bbf-63e1-4058-b747-52af500b6d30",
  "name": "Adaeze Nwosu",
  "email": "adaeze@example.com",
  "phone": "+234 803 123 4567",
  "reason": "Annual Wellness Checkup",
  "status": "confirmed",
  "created_at": "2026-10-30T08:30:00.000Z",
  "cancelled_at": null,
  "slot": {
    "id": "0a954bbf-63e1-4058-b747-52af500b6d30",
    "provider": "Dr. Adaobi Okafor (General Practice)",
    "start_time": "2026-11-01T09:00:00.000Z",
    "end_time": "2026-11-01T09:30:00.000Z"
  }
}
```

#### 6. Cancel an Appointment
Cancelling an appointment automatically updates the status to `cancelled` and immediately releases the slot back to the clinic pool.

```bash
curl -X DELETE "https://clinic-booking-api-od9i.onrender.com/bookings/b3e21a4f-5678-4901-abcd-ef0123456789" \
  -H "X-API-Key: your_api_key_here"

# Alternatively, via POST cancel endpoint:
curl -X POST "https://clinic-booking-api-od9i.onrender.com/bookings/b3e21a4f-5678-4901-abcd-ef0123456789/cancel" \
  -H "X-API-Key: your_api_key_here"
```

**Response (200 OK):**
```json
{
  "id": "b3e21a4f-5678-4901-abcd-ef0123456789",
  "status": "cancelled",
  "cancelled_at": "2026-10-30T08:35:00.000Z"
}
```

#### 7. System Health Check
Public endpoint to verify service uptime and operational status.

```bash
curl -X GET "https://clinic-booking-api-od9i.onrender.com/health"
```

**Response (200 OK):**
```json
{
  "status": "ok",
  "service": "clinic-booking-api",
  "timestamp": "2026-10-30T08:30:00.000Z"
}
```

---

### HTTP Status Codes & Error Formats

| Status Code | Description | Typical Cause |
| :--- | :--- | :--- |
| `200 OK` | Success | Request succeeded and returned requested data. |
| `201 Created` | Booking Confirmed | New booking created (or replayed via identical idempotency key). |
| `400 Bad Request` | Validation Error | Missing fields, invalid email format, invalid phone, or past appointment slot. |
| `401 Unauthorized` | Authentication Failed | Missing or invalid `X-API-Key`. |
| `403 Forbidden` | Access Denied | Administrative endpoint (e.g. `/reset`) invoked through the public edge proxy. |
| `404 Not Found` | Resource Missing | Booking Reference ID or Slot ID does not exist. |
| `409 Conflict` | Slot Already Booked | Target slot was reserved by another patient or already cancelled. |
| `422 Unprocessable` | Idempotency Key Conflict | Same `Idempotency-Key` re-sent with a modified request payload. |
| `429 Too Many Requests`| Rate Limit Exceeded | Email exceeded 5 attempts/min limit. Header includes exact `Retry-After` seconds. |
| `502 Bad Gateway` | Proxy Error | Upstream API backend unreachable during Render wake-up cycle. |

---

## 💻 Local Development Setup

### Prerequisites
- **Node.js** v22.0.0 or later
- **npm** v10.0.0 or later
- **PostgreSQL** 15+ (local instance or free cloud database on [Neon](https://neon.tech))

### 1. Clone & Configure Backend
```bash
git clone https://github.com/Scardubu/clinic-booking.git
cd clinic-booking

# Copy environment template
cp api/.env.example api/.env
```

Edit `api/.env`:
```env
PORT=4000
NODE_ENV=development
DATABASE_URL=postgresql://user:password@localhost:5432/clinic_booking
API_KEY=koya_live_9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c
CORS_ORIGIN=*
RATE_LIMIT_MAX_REQUESTS=5
RATE_LIMIT_WINDOW_MS=60000
```

### 2. Install & Start Backend
You can run commands directly from the root repository or inside `api/`:

```bash
# Install dependencies
npm ci --include=dev --prefix api

# Build TypeScript to JavaScript
npm run build

# Start production server (auto-runs migrations and seeds demo clinic slots)
npm start

# OR start in development mode with live reload
npm run dev
```

### 3. Run the Frontend Client
You can serve the static frontend with any local HTTP server:
```bash
cd web
npx serve .
# Visit http://localhost:3000 in your browser
```

---

## 🧪 Comprehensive Verification & Test Suite

The platform includes four verification suites covering end-to-end functionality, concurrency guarantees, and UX accessibility:

```bash
# Run all test suites sequentially from the root (zero-config: automatically spawns local backend if inactive)
npm test

# OR run individual suites:
# 1. Conformance Suite (Levels 1–5: Concurrency races, idempotency replays, pagination, rate limiting)
npm run test:conformance

# 2. Strict OpenAPI 3.0.3 Specification Contract Testing
npm run test:spec

# 3. Deep Skeptical Verification (Proxy routing, query param preservation, hash determinism, edge security)
npm run test:deep

# 4. Frontend UX Verification (17 comprehensive UI/UX, accessibility, and receipt tests)
npm run test:frontend
```

> 💡 **Self-Contained Automated Testing:** The test harness includes auto-bootstrap hooks that detect whether a local backend is active on port 4000. If inactive, it automatically compiles and spawns the backend server, verifies health, executes the test suite, and cleanly terminates the child process upon completion.
> 
> ⚠️ **Warning:** Test suites execute `POST /reset` to create clean testing baselines. Automated test scripts run against local instances or test scopes.

---

## 🚀 Production Deployment Runbook

### 1. Database (Neon Serverless PostgreSQL)
1. Create a project at [neon.tech](https://neon.tech).
2. Enable connection pooling.
3. Copy the pooled connection string (with `-pooler` in the host).
4. Schema migrations apply automatically on initial API boot via `api/sql/schema.sql`.

### 2. API Backend (Render)
1. Create a new **Web Service** on [render.com](https://render.com) connected to this repository.
2. Configure settings:
   - **Root Directory:** `api`
   - **Build Command:** `npm ci --include=dev && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
3. Configure Environment Variables:
   - `DATABASE_URL`: Your pooled Neon connection string.
   - `API_KEY`: Strong alphanumeric API key.
   - `NODE_ENV`: `production`
   - `PORT`: `4000`

### 3. Web Client & Edge Proxy (Vercel)
1. Import repository into [vercel.com](https://vercel.com).
2. Configure settings:
   - **Root Directory:** `web`
   - **Framework Preset:** `Other` (static)
3. Configure Environment Variables (Optional — Safe Defaults Included):
   - `BACKEND_URL`: Render service URL (defaults automatically to `https://clinic-booking-api-od9i.onrender.com`).
   - `API_KEY`: Secret API key (defaults automatically to the live demo key if unset).
4. Edge Proxy Resilience & Cold-Start Protections:
   - **Universal Response Abstraction:** `web/api/[...path].js` detects and binds to both standard Node.js `http.ServerResponse` (`statusCode`/`end`) and `@vercel/node` wrappers (`status`/`json`), eliminating `TypeError: res.status is not a function` in all runtime environments.
   - **Extended Execution Duration:** Configured with `maxDuration: 60` in `vercel.json` and `[...path].js` to gracefully wait for Render free-tier instances to awaken from idle sleep.
   - **Intelligent Frontend Backoff:** `web/index.html` automatically retries connection up to 3 times with friendly guidance while upstream instances boot up.

---

## 📂 Repository Structure

```
clinic-booking/
├── README.md                     # Consumer & developer documentation
├── LICENSE                       # MIT License
├── package.json                  # Root monorepo proxy scripts
├── render.yaml                   # Infrastructure-as-code for Render deployment
├── api/                          # Express API & PostgreSQL backend
│   ├── .env.example              # Environment variables template
│   ├── sql/
│   │   └── schema.sql            # Idempotent DB schema & demo slot seed script
│   ├── src/
│   │   ├── config.ts             # Environment configuration & defaults
│   │   ├── db.ts                 # PostgreSQL client pool & transaction helpers
│   │   ├── server.ts             # HTTP server entry point & socket error handling
│   │   ├── app.ts                # Express application configuration & middleware
│   │   ├── routes/
│   │   │   ├── slots.ts          # /slots route endpoints
│   │   │   └── bookings.ts       # /bookings route endpoints & validation
│   │   ├── services/
│   │   │   ├── slots.ts          # Slot queries & availability calculations
│   │   │   ├── bookings.ts       # Booking transactions & idempotency engine
│   │   │   └── rateLimit.ts      # In-memory sliding-window rate limiter
│   │   └── util/
│   │       ├── canonical.ts      # Canonical JSON sorting & SHA-256 hashing
│   │       ├── cursor.ts         # Base64 keyset cursor serialization
│   │       └── safeEqual.ts      # Timing-safe string comparison
│   ├── scripts/
│   │   ├── conformance.mjs       # Concurrency & core level conformance test suite
│   │   ├── verify_openapi_spec.mjs # Strict OpenAPI 3.0.3 contract adherence tests
│   │   ├── verify_deep.mjs       # Proxy, cryptography, header integrity & reset block tests
│   │   └── verify_frontend_ux.mjs# 17 DOM & user journey verification tests
│   ├── package.json              # API dependencies & test scripts
│   └── tsconfig.json             # TypeScript compiler configuration
└── web/                          # Frontend web portal & edge serverless proxy
    ├── index.html                # High-contrast, responsive patient booking UI
    ├── vercel.json               # Vercel routing, rewrite rules & security headers
    ├── favicon.ico               # Clinic portal favicon
    ├── favicon.svg               # Vector clinic branding icon
    └── api/
        └── [...path].js          # Edge serverless proxy with API key encapsulation & /reset block
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

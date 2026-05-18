# Specification: Granular Lens & Photo EXIF Metadata Framework

## 1. Architectural Philosophy: Purity & Multi-Device Compatibility

In **Centripetal ES**, we keep the existing `states` and `state_photos` tables 100% untouched. To support dynamic spatial coordinates and device logs across **Android (Samsung, Pixel, Xiaomi)** and **iOS (iPhone)**, we introduce a **Double-Decoupled Metadata Companion Table** called `photo_metadata_extractions`.

Because different phone manufacturers write EXIF segments in slightly different formats (Big Endian vs. Little Endian, different GPS degree-minute-second array structures), we solve compatibility at the database layer using a dual-storage strategy:
1. **Flat Indexable Columns**: Primary fields like GPS coordinates, altitudes, captured times, and device manufacturer/model are parsed and stored as flat columns for high-speed indexing and spatial SQL queries.
2. **`raw_exif` JSONB Column**: The entire parsed EXIF segment is dumped directly into a flexible JSONB column. This ensures that no matter what proprietary tags or custom parameters a phone model writes, we capture 100% of the telemetry with zero data loss!

```
+------------------+         +------------------------------+
|   state_photos   |         |  photo_metadata_extractions  |
|------------------|         |------------------------------|
| state_id (FK)    |         | id (PK)                      |
| photo_url (Unique|<------->| photo_url (FK, Unique)       |
| photo_description|         | gps_latitude (NUMERIC)       |
+------------------+         | gps_longitude (NUMERIC)      |
                             | gps_altitude (NUMERIC)       |
                             | captured_at (TIMESTAMP)      |
                             | device_make (VARCHAR)        |
                             | device_model (VARCHAR)       |
                             | raw_exif (JSONB)             |
                             +------------------------------+
```

---

## 2. Decoupled Risk & Image Extractions Database Schema

The database migration deploys two clean companion tables, keeping operational media tables pristine:

### 1. `state_risk_profiles`
Regulates narrative access dynamically based on trust thresholds:

```sql
CREATE TABLE state_risk_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id UUID UNIQUE NOT NULL REFERENCES states(id) ON DELETE CASCADE,
  risk_liquid NUMERIC DEFAULT 0.0,
  risk_exploit NUMERIC DEFAULT 0.0,
  risk_geo NUMERIC DEFAULT 0.0,
  risk_ident NUMERIC DEFAULT 0.0,
  aggregate_risk NUMERIC DEFAULT 0.0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

### 2. `photo_metadata_extractions`
Extracts, structures, and logs the raw physical EXIF coordinates and camera tags:

```sql
CREATE TABLE photo_metadata_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_url VARCHAR(1000) UNIQUE NOT NULL, -- Links to state_photos.photo_url
  gps_latitude NUMERIC DEFAULT NULL,       -- Decimal latitude degree (e.g. 9.58245)
  gps_longitude NUMERIC DEFAULT NULL,      -- Decimal longitude degree (e.g. 123.82134)
  gps_altitude NUMERIC DEFAULT NULL,       -- Altitude in meters
  captured_at TIMESTAMP WITH TIME ZONE DEFAULT NULL, -- DateTimeOriginal from camera EXIF
  device_make VARCHAR(255) DEFAULT NULL,    -- Camera manufacturer (e.g. 'Apple', 'Samsung')
  device_model VARCHAR(255) DEFAULT NULL,   -- Camera model (e.g. 'iPhone 13', 'Galaxy S21')
  raw_exif JSONB NOT NULL DEFAULT '{}'::jsonb, -- Raw parsed key-values for full compatibility
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_photo_metadata_coords ON photo_metadata_extractions(gps_latitude, gps_longitude);
CREATE INDEX idx_photo_metadata_device ON photo_metadata_extractions(device_make, device_model);
CREATE INDEX idx_photo_metadata_captured ON photo_metadata_extractions(captured_at);
```

---

## 3. High-Value Spatial and Anomaly Queries

Storing coordinates as flat numeric columns makes spatial bounding boxes and coordinate audits incredibly fast and efficient:

### 1. Spatial Search Query (Geofenced Radius Scan)
Find all images taken within a specific decimal bounding box (e.g. Plot B):

```sql
-- Find photos near Plot B boundaries (latitude 9.582, longitude 123.821)
SELECT sp.photo_url, sp.photo_description, pme.device_model, pme.captured_at
FROM state_photos sp
JOIN photo_metadata_extractions pme ON sp.photo_url = pme.photo_url
WHERE pme.gps_latitude BETWEEN 9.5815 AND 9.5825
  AND pme.gps_longitude BETWEEN 123.8205 AND 123.8215
ORDER BY pme.captured_at DESC;
```

### 2. Device Integrity Audit (Detect Spoofing)
Verify that a participant is using an active authorized company phone (e.g. company Pixel 6a or iPhone SE) for a premium validation action, rather than submitting third-party web uploads:

```sql
SELECT s.captured_by, sp.photo_url, pme.device_make, pme.device_model, pme.raw_exif->>'Software' as os_version
FROM states s
JOIN state_photos sp ON s.id = sp.state_id
JOIN photo_metadata_extractions pme ON sp.photo_url = pme.photo_url
WHERE pme.device_make NOT IN ('Apple', 'Google', 'Samsung') -- Flags generic/spoofed web software
   OR pme.gps_latitude IS NULL; -- Flags files uploaded without valid GPS telemetry
```

---

## 4. Key Architectural Strengths

*   **Pristine Core Schema**: Zero table pollution. Core operational logs and photo uploads are completely unaffected by security and EXIF telemetry parsing.
*   **Android and iOS Out-of-the-Box**: Storing the raw EXIF in `raw_exif` JSONB guarantees 100% coverage. Even if a specific phone model writes coordinates or shutter speeds using custom keynames, the extraction pipeline successfully logs it for auditing.
*   **Decoupled Extensibility**: If we decide to index standard crop science data from the image later, we simply append it to `raw_exif` or query it, leaving our operational media assets safe and untouched.

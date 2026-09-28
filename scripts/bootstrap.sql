--
-- Copyright 2026 Gilang Albathin Nurhabibi <https://github.com/athron98>
--
-- Author: Gilang Albathin Nurhabibi <https://github.com/athron98>
--
-- SPDX-License-Identifier: MIT
--
-- Licensed under the MIT License. See the LICENSE file at the repository root.

-- Bootstrap tabel metadata definisi koleksi (manual, opsional).
-- Runtime juga bikin otomatis (CREATE TABLE IF NOT EXISTS) di meta/store.ts.
--
-- Kolom di sini harus sama persis dengan CREATE TABLE di store.ts. Kalau tidak,
-- `db:setup` membuat tabel yang lebih sempit dari yang aplikasi kira, dan
-- ensureMetaTable harus menambal seluruhnya setiap boot. Land/colony ikut di sini
-- karena primary key sebenarnya (land, colony, name) — bukan name saja.
CREATE TABLE IF NOT EXISTS _meta_collections (
  land TEXT NOT NULL DEFAULT 'default',
  colony TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  "group" TEXT,
  icon TEXT,
  timestamps INTEGER NOT NULL DEFAULT 0,
  soft_delete INTEGER NOT NULL DEFAULT 0,
  primary_key TEXT NOT NULL DEFAULT 'id',
  -- 'read' | 'write' | 'hide'. NULL berarti 'read': collection yang tidak
  -- pernah disetel tidak boleh ditulis agent.
  mcp TEXT,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (land, colony, name)
);

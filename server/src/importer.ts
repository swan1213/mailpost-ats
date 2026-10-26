import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { config } from './config.js';
import { db, now, transaction, type MessageRow } from './db.js';
import { EMAIL_RE, normalizeText, ValidationError } from './settings.js';

export interface ImportResult {
  uploadId: number;
  filename: string;
  rows: number;
  added: number;
  updated: number;
  /** Unsent rows that are no longer in the file */
  removed: number;
  duplicates: number;
  invalid: number;
}

function parseCsv(content: string): Record<string, string | undefined>[] {
  let records: Record<string, string | undefined>[];
  try {
    records = parse(content, {
      columns: (header: string[]) => header.map((h) => h.trim().toLowerCase()),
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  } catch (err) {
    throw new ValidationError(`Could not read the CSV: ${(err as Error).message}`);
  }
  // Spreadsheet exports often end with rows of empty cells (",,,"); they are not recipients.
  records = records.filter((r) => Object.values(r).some((v) => v?.trim()));
  if (!records.length) throw new ValidationError('The CSV has no rows');
  if (!('email' in records[0])) {
    throw new ValidationError('The CSV needs an "email" column (plus name, location, subject, content)');
  }
  return records;
}

/**
 * Loads a CSV into the upload with the same file name (created if new), so the upload mirrors the file:
 * new emails are added, unsent rows are refreshed, and unsent rows no longer in the file are removed.
 * Anything already queued or sent is never touched, so nobody is emailed twice.
 * `isNewUpload` marks it as the latest upload (Re-import doesn't).
 */
export function importCsv(filename: string, content: string, isNewUpload = false): ImportResult {
  const records = parseCsv(content);

  return transaction(() => {
    db.prepare(
      isNewUpload
        ? 'INSERT INTO uploads (filename, uploaded_at) VALUES (?, ?) ON CONFLICT (filename) DO UPDATE SET uploaded_at = excluded.uploaded_at'
        : 'INSERT INTO uploads (filename, uploaded_at) VALUES (?, ?) ON CONFLICT (filename) DO NOTHING',
    ).run(filename, now());
    const uploadId = (db.prepare('SELECT id FROM uploads WHERE filename = ?').get(filename) as { id: number }).id;

    const find = db.prepare('SELECT * FROM messages WHERE upload_id = ? AND email = ?');
    const insert = db.prepare(`
      INSERT INTO messages (upload_id, email, name, location, csv_subject, csv_content, status, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const update = db.prepare(`
      UPDATE messages SET name = ?, location = ?, csv_subject = ?, csv_content = ?, status = ?, last_error = ?, updated_at = ?
      WHERE id = ?`);

    const result: ImportResult = {
      uploadId,
      filename,
      rows: records.length,
      added: 0,
      updated: 0,
      removed: 0,
      duplicates: 0,
      invalid: 0,
    };
    const seen = new Set<string>();
    records.forEach((record, index) => {
      const email = (record.email ?? '').trim().toLowerCase() || `(missing email, entry ${index + 1})`;
      if (seen.has(email)) {
        result.duplicates++;
        return;
      }
      seen.add(email);

      const name = (record.name ?? '').trim();
      const location = (record.location ?? '').trim();
      const subject = (record.subject ?? '').trim();
      const body = normalizeText(record.content ?? '');
      const problem = !EMAIL_RE.test(email)
        ? 'Invalid email address'
        : subject && !body
          ? 'Has a subject but no content'
          : null;
      if (problem) result.invalid++;
      const status = problem ? 'skipped' : 'new';

      const existing = find.get(uploadId, email) as MessageRow | undefined;
      if (!existing) {
        insert.run(uploadId, email, name, location, subject, body, status, problem, now(), now());
        result.added++;
      } else if (
        (existing.status === 'new' || existing.status === 'skipped') &&
        (existing.name !== name ||
          existing.location !== location ||
          existing.csv_subject !== subject ||
          existing.csv_content !== body ||
          existing.status !== status)
      ) {
        update.run(name, location, subject, body, status, problem, now(), existing.id);
        result.updated++;
      }
    });

    const unsent = db
      .prepare("SELECT id, email FROM messages WHERE upload_id = ? AND status IN ('new', 'skipped')")
      .all(uploadId) as { id: number; email: string }[];
    const remove = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const row of unsent) {
      if (!seen.has(row.email)) result.removed += Number(remove.run(row.id).changes);
    }
    return result;
  });
}

function safeName(filename: string): string {
  const base = path.basename(filename).replace(/[^\w.\- ()]/g, '_');
  return /\.csv$/i.test(base) ? base : `${base}.csv`;
}

/** Saves an uploaded file into CSV_DIR (so Re-import sees it later) and imports it. */
export function saveAndImport(filename: string, content: string): ImportResult {
  const name = safeName(filename);
  parseCsv(content); // reject bad files before writing anything
  fs.mkdirSync(config.csvDir, { recursive: true });
  fs.writeFileSync(path.join(config.csvDir, name), content, 'utf8');
  return importCsv(name, content, true);
}

/** Re-reads every CSV in CSV_DIR. One bad file doesn't stop the others. */
export function reimportFolder() {
  fs.mkdirSync(config.csvDir, { recursive: true });
  const files = fs.readdirSync(config.csvDir).filter((f) => /\.csv$/i.test(f)).sort();
  const results: ImportResult[] = [];
  const errors: { filename: string; error: string }[] = [];
  for (const filename of files) {
    try {
      results.push(importCsv(filename, fs.readFileSync(path.join(config.csvDir, filename), 'utf8')));
    } catch (err) {
      errors.push({ filename, error: (err as Error).message });
    }
  }
  return {
    folder: config.csvDir,
    files: files.length,
    added: results.reduce((n, r) => n + r.added, 0),
    updated: results.reduce((n, r) => n + r.updated, 0),
    removed: results.reduce((n, r) => n + r.removed, 0),
    errors,
  };
}

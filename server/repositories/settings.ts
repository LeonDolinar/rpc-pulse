import { eq } from 'drizzle-orm';
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from '../../shared/schemas.js';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

const KEY = 'app';

export function getSettings(db: Db): Settings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return DEFAULT_SETTINGS;
  // Merge onto defaults so settings added in newer versions get sensible values.
  const stored = row.value as Partial<Settings>;
  const merged = {
    defaults: { ...DEFAULT_SETTINGS.defaults, ...stored.defaults },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    retention: { ...DEFAULT_SETTINGS.retention, ...stored.retention },
  };
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function saveSettings(db: Db, value: Settings): Settings {
  db.insert(settings)
    .values({ key: KEY, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
  return value;
}

// Loads test/fixtures/posts/*.json (PLAN section 15). Each fixture is a raw post plus
// what the pipeline is expected to make of it; P2 reuses the same files for extraction.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../util/root.js';
import type { Angle } from '../pipeline/titles.js';
import type { RawSource } from '../pipeline/dedupe.js';

export interface ExpectedJob {
  title: string;
  company: string | null;
  location: string | null;
  work_mode: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'unknown';
  years_min: number | null;
  apply_channel: 'email' | 'form' | 'whatsapp_dm' | 'unknown';
  apply_email: string | null;
  apply_url: string | null;
  subject_hint: string | null;
  deadline: string | null;
  language: 'en' | 'ar' | 'mixed';
  tier: 1 | 2 | 3 | null;
  angle: Angle | null;
  excluded: 'excluded_title' | 'seniority' | null;
  skip_reason: string | null;
  flags: string[];
}

export interface Fixture {
  id: string;
  description: string;
  source: RawSource;
  source_name: string;
  source_ref: string;
  posted_at: string;
  text: string;
  media: string | null;
  expected: {
    is_job_post: boolean;
    jobs: ExpectedJob[];
    dedupe: { layer: 'L1' | 'L2' | 'L3'; duplicate_of: string } | null;
  };
}

export const FIXTURE_DIR = join(REPO_ROOT, 'test', 'fixtures', 'posts');

/** All fixtures, oldest post first (the order a real run would see them). */
export function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture)
    .sort((a, b) => a.posted_at.localeCompare(b.posted_at) || a.id.localeCompare(b.id));
}

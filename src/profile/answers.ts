// Writes ready answers (application_answers) into profile/master_profile.yaml from the
// dashboard (D35). The YAML file stays the single source of truth: the edit keeps its
// comments, the whole profile is validated before writing, the previous version is kept
// as .bak, and the write is atomic (temp file + rename).
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { parseProfile } from './load.js';

export class AnswerError extends Error {
  override name = 'AnswerError';
}

const KEY = /^[a-z][a-z0-9_]{1,49}$/;

/** Sets (or, with an empty value, removes) application_answers[key]. Returns all answers. */
export function setAnswer(path: string, key: string, value: string): Record<string, string> {
  if (!KEY.test(key)) throw new AnswerError('key: lowercase letters, digits and _ (2-50 chars)');
  const v = value.trim();
  if (v.length > 500) throw new AnswerError('answer: at most 500 characters');
  if (/[\r\n]/.test(v)) throw new AnswerError('answer: one line');
  const doc = parseDocument(readFileSync(path, 'utf8'));
  if (v) doc.setIn(['application_answers', key], v);
  else doc.deleteIn(['application_answers', key]);
  const text = doc.toString();
  const profile = parseProfile(doc.toJS(), path); // throws if the result is not a valid profile
  copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return profile.application_answers;
}

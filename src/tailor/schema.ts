// What the tailor model returns (PLAN 8.2). It selects ids and may rephrase bullet text;
// code assembles the CV from the profile, so the model never writes contact data,
// dates, education or certifications.
import { z } from 'zod';

const BulletPick = z.strictObject({
  id: z.string().max(60),
  text: z.string().min(10).max(400).describe('The bullet, rephrased for this job or copied as is'),
});

const EntryPick = z.strictObject({
  id: z.string().max(60),
  bullets: z.array(BulletPick).min(1).max(5),
});

export const TailorOutputSchema = z.strictObject({
  headline: z.string().min(5).max(110),
  summary: z.string().min(80).max(650),
  skills: z.array(z.string().max(60)).min(8).max(22).describe('Skill ids, most relevant first'),
  experience: z.array(EntryPick).max(4),
  projects: z.array(EntryPick).min(2).max(5).describe('Most relevant first'),
  courses: z.array(z.string().max(60)).max(6).describe('Course ids worth listing for this job'),
  cover_letter: z.strictObject({
    greeting: z.string().max(80),
    paragraphs: z.array(z.string().min(40).max(1400)).length(3),
    closing: z.string().max(80),
  }),
  email_body: z.string().min(40).max(900).describe('3-5 short lines, no signature'),
  why_this_role: z.string().min(20).max(300),
});
export type TailorOutput = z.infer<typeof TailorOutputSchema>;

// What the tailor model returns (PLAN 8.2). It selects ids and may rephrase bullet text;
// code assembles the CV from the profile, so the model never writes contact data,
// dates, education or certifications.
import { z } from 'zod';

const BulletPick = z.strictObject({
  id: z.string().max(60),
  label: z
    .string()
    .max(60)
    .optional()
    .describe('Bold lead-in; keep the source label if it has one'),
  text: z.string().min(10).max(400).describe('The bullet, rephrased for this job or copied as is'),
});

const EntryPick = z.strictObject({
  id: z.string().max(60),
  bullets: z.array(BulletPick).min(1).max(5),
});

export const TailorOutputSchema = z.strictObject({
  headline: z.string().min(5).max(110),
  summary: z.string().min(80).max(650),
  skills: z
    .array(z.string().max(60))
    .min(15)
    .max(95)
    .describe(
      'Skill ids ranked by relevance to this job, most relevant first; the CV lists every skill, this only orders them',
    ),
  experience: z.array(EntryPick).max(4),
  projects: z.array(EntryPick).min(4).max(6).describe('At least 4, most relevant first'),
  courses: z.array(z.string().max(60)).max(6).describe('Course ids worth listing for this job'),
  cover_letter: z.strictObject({
    greeting: z.string().max(80),
    paragraphs: z.array(z.string().min(40).max(1400)).length(3),
    closing: z.string().max(80),
  }),
  why_this_role: z.string().min(20).max(300),
});
export type TailorOutput = z.infer<typeof TailorOutputSchema>;

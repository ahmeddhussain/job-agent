// Output schemas for every model call. One zod schema gives the JSON Schema passed to
// `claude -p --json-schema` and the runtime validation of what comes back.
import { z } from 'zod';

const shortText = z.string().max(300);

export const ExtractedJobSchema = z.strictObject({
  title: z.string().min(2).max(120).describe('Job title in English (translate Arabic titles)'),
  company: z.string().max(120).nullable().describe('Hiring company; null if not named'),
  location: z.string().max(120).nullable().describe('City/area in English; null if not stated'),
  country: z
    .string()
    .max(60)
    .nullable()
    .describe(
      'Country of the job location in English (Egypt for Egyptian cities); null if not stated',
    ),
  work_mode: z.enum(['onsite', 'hybrid', 'remote', 'unknown']),
  seniority: z.enum(['intern', 'junior', 'mid', 'senior', 'lead', 'unknown']),
  years_min: z
    .number()
    .int()
    .min(0)
    .max(40)
    .nullable()
    .describe('Minimum years of experience; null if not stated'),
  requirements: z.array(shortText).max(30),
  nice_to_have: z.array(shortText).max(20),
  apply_channel: z.enum(['email', 'form', 'whatsapp_dm', 'unknown']),
  apply_email: z.string().max(200).nullable().describe('Copied exactly from the post'),
  apply_url: z.string().max(2000).nullable().describe('Copied exactly from the post'),
  apply_phone: z
    .string()
    .max(40)
    .nullable()
    .describe('WhatsApp/phone to apply to, if that is the channel'),
  subject_hint: z
    .string()
    .max(200)
    .nullable()
    .describe('Exact email subject the post requires, if any'),
  deadline: z.string().max(10).nullable().describe('YYYY-MM-DD, or null'),
  language: z.enum(['en', 'ar', 'mixed']),
  eligibility: z
    .array(shortText)
    .max(10)
    .describe(
      'Hard requirements on the person: gender, nationality, residence, military status, specific degree, certification',
    ),
  scam_signals: z.array(shortText).max(10),
});
export type ExtractedJob = z.infer<typeof ExtractedJobSchema>;

export const ExtractResultSchema = z.strictObject({
  is_job_post: z.boolean(),
  jobs: z.array(ExtractedJobSchema).max(10),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export const FitResultSchema = z.strictObject({
  fit_score: z.number().int().min(0).max(100),
  matched: z
    .array(
      z.strictObject({
        requirement: shortText,
        evidence: z
          .array(z.string().max(60))
          .min(1)
          .max(6)
          .describe('Profile ids (facts, entries or skills) proving it'),
      }),
    )
    .max(30),
  missing: z.array(shortText).max(30),
  eligibility_issues: z
    .array(shortText)
    .max(10)
    .describe('Eligibility requirements the profile does not meet or cannot show'),
  summary: z.string().max(240),
});
export type FitResult = z.infer<typeof FitResultSchema>;

export const PreflightSchema = z.strictObject({ ok: z.boolean() });

export const FormAnswersSchema = z.strictObject({
  answers: z
    .array(
      z.strictObject({
        id: z.string().max(20),
        value: z.string().max(3000).nullable(),
        options: z.array(z.string().max(200)).max(30),
        source: z.string().max(160),
      }),
    )
    .max(80),
});
export type FormAnswers = z.infer<typeof FormAnswersSchema>;

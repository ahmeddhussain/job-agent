import { describe, expect, it } from 'vitest';
import { hammingDistance, simhash } from '../../src/util/simhash.js';
import {
  canonicalTitle,
  diceSimilarity,
  hashKey,
  normalizeCompany,
  normalizeText,
  tokenSetSimilarity,
} from '../../src/util/text.js';
import { canonicalizeUrl, findEmails } from '../../src/util/url.js';

describe('normalizeText / hashKey', () => {
  it('removes emoji and collapses whitespace but keeps words and emails', () => {
    expect(normalizeText('🚀🚀  Hiring:   DevOps\t Engineer ✅\n\n\nmail me@x.example')).toBe(
      'Hiring: DevOps Engineer\n\nmail me@x.example',
    );
  });

  it('gives forwards with different emoji, bold markers and spacing the same key', () => {
    const a = '📢 Hiring NOC Engineer\n✅ 24/7 shifts\n📩 noc@o.example';
    const b = '🔥🔥 *Hiring NOC Engineer*\n\n✔️ 24/7   shifts\n📧 noc@o.example';
    expect(hashKey(a)).toBe(hashKey(b));
  });

  it('ignores Arabic diacritics, tatweel and alef/yaa/taa-marbuta variants', () => {
    expect(hashKey('مُهَنْدِس دعـــم فنى')).toBe(hashKey('مهندس دعم فني'));
    expect(hashKey('إدارة الشبكة')).toBe(hashKey('اداره الشبكه'));
  });

  it('token-set similarity is 1 for reordered tokens and lower for different text', () => {
    expect(tokenSetSimilarity('aws terraform docker', 'docker aws terraform')).toBe(1);
    expect(tokenSetSimilarity('aws terraform docker', 'sales marketing')).toBe(0);
  });
});

describe('titles and companies', () => {
  it('canonical titles drop seniority words and map synonyms', () => {
    expect(canonicalTitle('Sr. Dev Ops Eng.')).toBe('devops engineer');
    expect(canonicalTitle('SRE')).toBe('site reliability engineer');
    expect(canonicalTitle('Junior SysAdmin')).toBe('system administrator');
    expect(canonicalTitle('Cloud Engineer (AWS)')).toBe(canonicalTitle('Cloud Engineer – AWS'));
  });

  it('dice similarity separates different roles at the same recruiter', () => {
    expect(diceSimilarity('devops engineer', 'devops engineer')).toBe(1);
    expect(diceSimilarity('monitoring engineer', 'noc engineer')).toBeLessThan(0.85);
    expect(diceSimilarity('linux system administrator', 'cloud support engineer')).toBeLessThan(
      0.85,
    );
  });

  it('normalizes company names', () => {
    expect(normalizeCompany('Nilecode Systems, Inc.')).toBe('nilecode systems');
    expect(normalizeCompany('  ')).toBeNull();
    expect(normalizeCompany(null)).toBeNull();
  });
});

describe('canonicalizeUrl', () => {
  it('strips utm and tracking params and the fragment', () => {
    expect(canonicalizeUrl('https://www.Example.com/jobs/1/?utm_source=wa&b=2&a=1#apply')).toBe(
      'https://example.com/jobs/1?a=1&b=2',
    );
  });

  it('reduces every LinkedIn job link form to one canonical URL', () => {
    const want = 'https://linkedin.com/jobs/view/4123456789';
    expect(canonicalizeUrl('https://www.linkedin.com/jobs/view/4123456789/?utm_source=share')).toBe(
      want,
    );
    expect(
      canonicalizeUrl('https://www.linkedin.com/comm/jobs/view/4123456789/?trackingId=x&trk=y'),
    ).toBe(want);
    expect(
      canonicalizeUrl('https://eg.linkedin.com/jobs/view/devops-engineer-at-acme-4123456789'),
    ).toBe(want);
    expect(canonicalizeUrl('https://www.linkedin.com/jobs/search/?currentJobId=4123456789')).toBe(
      want,
    );
  });

  it('strips ATS-board tracking params (Greenhouse, Lever)', () => {
    expect(canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/1?gh_src=wa#app')).toBe(
      'https://boards.greenhouse.io/acme/jobs/1',
    );
    expect(canonicalizeUrl('https://jobs.lever.co/acme/abc?lever-source=WhatsApp')).toBe(
      'https://jobs.lever.co/acme/abc',
    );
  });

  it('rejects non-http and malformed URLs', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });

  it('finds emails case-insensitively and de-duplicated', () => {
    expect(findEmails('CV to HR@Acme.example or hr@acme.example')).toEqual(['hr@acme.example']);
  });
});

describe('simhash', () => {
  const base =
    'DevOps Engineer at Nilecode Systems in Cairo. AWS, Terraform, Docker, Kubernetes, Jenkins, GitHub Actions and Linux administration. Send your CV to careers@nilecode.example';

  it('is 16 hex chars and identical for identical text', () => {
    expect(simhash(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(simhash(base), simhash(base))).toBe(0);
  });

  it('is close for a small edit and far for unrelated text', () => {
    const edited = base.replace('Linux administration', 'Linux administration, good English');
    const other =
      'Data Analyst at Pyramid Pay. Python, SQL and Power BI dashboards for finance teams. Apply on our careers site today please';
    const near = hammingDistance(simhash(base), simhash(edited));
    const far = hammingDistance(simhash(base), simhash(other));
    expect(near).toBeLessThan(far);
    expect(far).toBeGreaterThan(15);
  });
});

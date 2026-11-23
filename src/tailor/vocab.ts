// Technology vocabulary and number extraction for the truth validator (PLAN 8.1).
// A term counts as "claimed" when it appears in text; the validator then checks that
// the source fact (for a rephrased bullet) or the profile (for free text) contains it too.
import type { Profile } from '../profile/load.js';

/**
 * General technology terms an employer might ask for. Deliberately excludes words that
 * are also ordinary English ("go", "excel", "spark", "chef") to avoid false alarms.
 */
const GENERAL_TERMS = [
  'aws',
  'amazon web services',
  'azure',
  'gcp',
  'google cloud',
  'oracle cloud',
  'alibaba cloud',
  'digitalocean',
  'kubernetes',
  'k8s',
  'docker',
  'podman',
  'containerd',
  'openshift',
  'rancher',
  'nomad',
  'eks',
  'aks',
  'gke',
  'ecs',
  'fargate',
  'lambda',
  's3',
  'ec2',
  'rds',
  'vpc',
  'iam',
  'route 53',
  'cloudfront',
  'sqs',
  'sns',
  'dynamodb',
  'cloudwatch',
  'cloudformation',
  'cloudtrail',
  'terraform',
  'opentofu',
  'pulumi',
  'ansible',
  'puppet',
  'saltstack',
  'packer',
  'vagrant',
  'jenkins',
  'gitlab',
  'gitlab ci',
  'github actions',
  'circleci',
  'travis',
  'bamboo',
  'teamcity',
  'azure devops',
  'argocd',
  'argo cd',
  'argo rollouts',
  'flux',
  'helm',
  'kustomize',
  'spinnaker',
  'tekton',
  'istio',
  'linkerd',
  'consul',
  'vault',
  'cilium',
  'calico',
  'envoy',
  'prometheus',
  'grafana',
  'loki',
  'tempo',
  'jaeger',
  'opentelemetry',
  'alertmanager',
  'elk',
  'elasticsearch',
  'logstash',
  'kibana',
  'splunk',
  'datadog',
  'new relic',
  'zabbix',
  'nagios',
  'dynatrace',
  'appdynamics',
  'fluent bit',
  'fluentd',
  'promtail',
  'solarwinds',
  'prtg',
  'kafka',
  'rabbitmq',
  'activemq',
  'redis',
  'memcached',
  'mysql',
  'postgresql',
  'postgres',
  'mongodb',
  'mariadb',
  'oracle database',
  'sql server',
  'mssql',
  'cassandra',
  'sqlite',
  'python',
  'java',
  'golang',
  'javascript',
  'typescript',
  'node.js',
  'nodejs',
  'bash',
  'powershell',
  'groovy',
  'ruby',
  'php',
  'c#',
  '.net',
  'rust',
  'scala',
  'kotlin',
  'perl',
  'fastapi',
  'flask',
  'django',
  'spring boot',
  'react',
  'angular',
  'vue',
  'rhel',
  'red hat',
  'centos',
  'rocky linux',
  'ubuntu',
  'debian',
  'suse',
  'amazon linux',
  'windows server',
  'active directory',
  'exchange',
  'office 365',
  'microsoft 365',
  'intune',
  'sccm',
  'vmware',
  'vsphere',
  'esxi',
  'hyper-v',
  'proxmox',
  'openstack',
  'citrix',
  'nginx',
  'apache',
  'haproxy',
  'tomcat',
  'iis',
  'selinux',
  'firewalld',
  'iptables',
  'wireguard',
  'openvpn',
  'squid',
  'nfs',
  'samba',
  'cisco',
  'juniper',
  'mikrotik',
  'fortinet',
  'fortigate',
  'palo alto',
  'huawei',
  'ospf',
  'bgp',
  'mpls',
  'vlan',
  'stp',
  'eigrp',
  'sd-wan',
  'ccna',
  'ccnp',
  'ccie',
  'rhcsa',
  'rhce',
  'cka',
  'ckad',
  'cks',
  'itil',
  'comptia',
  'mcsa',
  'hcia',
  'hcip',
  'jira',
  'servicenow',
  'zendesk',
  'freshdesk',
  'confluence',
  'sonarqube',
  'trivy',
  'snyk',
  'cosign',
  'nexus',
  'artifactory',
  'maven',
  'gradle',
  'npm',
  'freeipa',
  'ldap',
  'kerberos',
  'keycloak',
  'okta',
  'oauth',
  'oidc',
  'saml',
  'irsa',
  'backstage',
  'airflow',
  'hadoop',
  'power bi',
  'tableau',
  'sap',
  'salesforce',
];

function escape(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive whole-term matcher (terms with dots or symbols included). */
function termRegex(term: string): RegExp {
  return new RegExp(`(?<![\\w.#+-])${escape(term)}(?![\\w#+-])`, 'i');
}

export class Vocabulary {
  private readonly terms: [string, RegExp][];

  constructor(extra: string[] = []) {
    const all = [
      ...new Set([...GENERAL_TERMS, ...extra.map((t) => t.toLowerCase().trim())]),
    ].filter((t) => t.length >= 2);
    // Longest first, so "github actions" is found before "github".
    all.sort((a, b) => b.length - a.length);
    this.terms = all.map((t) => [t, termRegex(t)]);
  }

  /** Terms present in the text. */
  find(text: string): Set<string> {
    const out = new Set<string>();
    for (const [t, re] of this.terms) if (re.test(text)) out.add(t);
    return out;
  }
}

/** Builds the vocabulary from general terms plus every skill and tag in the profile. */
export function vocabularyFor(p: Profile): Vocabulary {
  // Skill names only (split on commas/slashes, parentheses expanded). Bullet tags are
  // NOT used: they hold ordinary words like "documentation" (troubleshooting #10).
  const extra: string[] = [];
  for (const s of Object.values(p.skills).flat()) {
    const inner = /\((.*?)\)/.exec(s.name)?.[1] ?? '';
    for (const part of [s.name.replace(/\(.*?\)/g, ''), inner].join(',').split(/[,/]/)) {
      const t = part.trim();
      if (t.length >= 2 && t.split(/\s+/).length <= 3) extra.push(t);
    }
  }
  return new Vocabulary(extra);
}

/**
 * Numbers that make a claim: digit runs not glued to a preceding letter (so "EC2", "S3",
 * "k8s" are names, not numbers). Thousands separators are removed.
 */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z\d.])\d+(?:[.,]\d+)*/g)) {
    out.add(m[0].replace(/,(?=\d{3}\b)/g, '').replace(/[.,]$/, ''));
  }
  return out;
}

/** All profile text the model may draw free-text claims from. */
export function profileText(p: Profile): string {
  return [
    ...Object.values(p.specialisms).flatMap((s) => [s.headline, s.summary, s.pitch, s.motivation]),
    ...[...p.experience, ...p.projects].flatMap((e) => [
      e.name ?? '',
      e.title ?? '',
      e.company ?? '',
      e.dates ?? '',
      e.stack ?? '',
      ...e.bullets.map((b) => b.text),
    ]),
    ...p.stories.map((s) => s.text),
    ...Object.values(p.skills)
      .flat()
      .map((s) => s.name),
    ...p.education.map((e) => `${e.degree} ${e.school} ${e.dates} ${e.gpa ?? ''}`),
    ...p.certifications.map((c) => c.name),
    ...p.courses.map((c) => `${c.name} ${c.dates ?? ''}`),
    ...p.badges.map((b) => b.name),
    p.candidate.location,
  ].join('\n');
}

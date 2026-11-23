# Profiles

A profile is one person's whole setup, in one folder:

```
profiles/<name>/
├── config.yaml        your settings (only what differs from config/defaults.yaml)
├── profile.yaml       your facts: the only source for every CV, letter and form answer
├── titles.yaml        the job titles you want, and never want
├── companies.yaml     companies whose job boards are always polled (optional)
├── .env               private values (optional Claude token)
├── secrets/           Gmail client and token (if you connect Gmail)
├── data/              the database, the WhatsApp session, the browser sign-ins
└── output/            every CV, cover letter and application package
```

Everything in it is private: `.gitignore` and the pre-commit secrets scan keep it out of
Git. Only `profiles/example/` (the fictional Mona Adel) is shared. Back up, move or delete a
profile by copying, moving or deleting its folder.

Several people can use one checkout: each runs `./agent.sh init` with their own name.
Commands then take `--profile <name>`, or `./agent.sh use <name>` switches the default.

---

## profile.yaml

The agent can only **select and rephrase** what is in this file. The validator rejects a
CV or letter that adds a skill, a number, an employer or a certification that isn't here.
So the file has to be complete and true. The full example is
[`profiles/example/profile.yaml`](../profiles/example/profile.yaml).

### The parts

| Key | What goes in it |
|---|---|
| `candidate` | name (`first_name`, `last_name`, `full_name` for the CV header), `location`, `email`, `phone`, `links` (GitHub, LinkedIn, portfolio) |
| `max_years_required` | the most years of experience a job may ask for and still be a match |
| `specialisms` | how you present yourself for different kinds of jobs (below) |
| `default_specialism` | used when no specialism matches a job title |
| `featured_projects` | project ids that always get bullets on the CV |
| `cover_letter.style` | short style rules for your letters ("150–220 words, no clichés") |
| `education`, `certifications`, `badges`, `courses` | each with an `id` |
| `not_held` | things you must **never** claim (certifications or tools people in your field often have). They can't appear in any CV or letter |
| `experience`, `projects` | entries with `id`, title or name, company, dates, `stack`, `status` (`done` / `in_progress`), and `bullets` |
| `stories` | short true stories the cover letter can tell (an outage you fixed, a result you're proud of) |
| `skills` | groups of skills; each skill has `level` (`strong` / `working` / `familiar`) and `evidence`: the experience or project ids that show it. `core: true` skills appear on every CV; the others only when a job asks for them |
| `soft_skills`, `known_gaps`, `languages` | as they say |
| `application_answers` | ready answers for application forms (notice period, expected salary, relocation, military status…) |

### Bullets

```yaml
bullets:
  - id: webapp_terraform            # unique, lowercase snake_case
    label: Infrastructure as code   # optional bold lead-in on the CV
    text: Built a VPC with public and private subnets, an ALB and an RDS database entirely in Terraform modules.
    tags: [ aws, terraform ]        # help the agent pick bullets for a job
    status: in_progress             # optional: can only be described as in progress
```

Write each bullet once, as the best true version. The agent picks and shortens bullets per
job; it never adds to them. Numbers you write ("about 25 tickets a week") are the only
numbers it may use.

### Specialisms

Each specialism is one way of presenting yourself: "IT Support Engineer" for support jobs,
"Junior Cloud Engineer" for cloud jobs. They are yours to define, with any names:

```yaml
specialisms:
  support:                                   # checked first
    match: [ 'support', 'help[\s-]?desk' ]   # job-title regexes (case-insensitive)
    headline: IT Support Engineer            # the CV's title line
    summary: >-                              # the CV's profile paragraph
      IT support engineer with a year of hands-on help-desk work...
    pitch: I solve users' problems quickly and write down the fix.
    evidence: [ helpdesk_tickets, helpdesk_runbooks ]   # bullet/story ids the letter prefers
    motivation: I enjoy being the person who gets a team working again.
    detailed_projects: [ home_lab ]          # extra projects with bullets for these jobs
  cloud:
    match: [ 'cloud', 'dev\s?ops' ]
    ...
default_specialism: cloud
```

For each job, the first specialism (in file order) whose `match` fits the title is used;
otherwise `default_specialism`. A frontend developer might define `frontend` and
`fullstack`; a data analyst `analytics` and `reporting`.

### Leaving something out for now

Any list item with `confirmed: false` is ignored until you set it to `true` (or delete the
line). Use it for a fact you still need to check.

### Checking your edits

The dashboard's editor (Profile → Edit profile files) validates before it saves. From a
terminal:

```bash
./agent.sh reviewed
```

Both check the same rules a run checks: every id unique, every `evidence` and project
reference exists, every `match` regex compiles, `default_specialism` exists.

---

## titles.yaml

```yaml
p1:        # wanted most: prepared at a lower fit score (scoring.thresholds.p1)
  - 'cloud\s+(engineer|support)'
p2:        # adjacent roles: a higher score needed (thresholds.p2)
  - 'systems?\s+(administrator|engineer)'
exclude:   # never, whatever the score
  - 'sales'
```

Patterns are case-insensitive regexes, matched against the job title (Arabic titles are
translated first). A title in none of the lists is tier P3: prepared only at a high score
(`thresholds.p3`). `exclude` always wins. You can also exclude a title from the dashboard,
and "Not a fit" reasons suggest exclusions you can accept with one click.

## companies.yaml

Optional. Companies whose job boards are always polled, even before any of their jobs shows
up elsewhere:

```yaml
companies:
  - { name: Careem, ats: greenhouse, board: careem }
```

Find the entry for a careers page with `npm run agent -- ats:detect <careers-url>`.
Companies are also discovered automatically from job links, so this list can stay short.
See [sources.md](sources.md#company-boards).

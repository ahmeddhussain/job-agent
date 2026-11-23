# Audit: an independent re-collection against the agent's database (2026-11-23)

**Question (Ahmed):** can he rely on the agent alone, without searching himself? So: did it miss
anything, did it bring the jobs he wants, and are the time limit and fit check right?

**Method:** the sources were re-read by hand, independently of the agent, and compared with
`data/agent.db` after 3 live runs:
- every WhatsApp message in the group and both followed channels (625, read-only);
- every labelled alert email since 15 Nov (41);
- LinkedIn's public search for the 8 titles, last 24 h, up to 10 pages each (163 unique listings, twice the agent's page limit).

Each skip reason was then checked against its post, and Ahmed's own decisions were read as ground truth.

## Results

| Check | Result |
|---|---|
| WhatsApp recall | 36 of 36 messages that could be jobs, inside the collection windows, were stored. The others were a system notice, an unknown message type and a 1-line message without a link |
| Alert recall | 28 of 28 job-list emails stored; 13 correctly left out (8 receipts/activations, 5 LinkedIn alerts) |
| LinkedIn alerts vs search | Every job in the 5 skipped LinkedIn alerts (Merck, PaxeraHealth) was in the database from the search: the search covers what the alerts carried |
| LinkedIn recall | 11 of 11 listings with a target or adjacent title were in the database. All 163 listings were from the last 24 h. LinkedIn refused 12 of 46 requests (handled by retries) |
| Page limit | No target or adjacent title was found beyond the agent's 5-page limit |
| Time limit | All 12 "too old" skips were posted 31–365 days earlier; all 3 "deadline passed" were past |
| Experience | All 49 "too many years" skips ask for 4+ years. 5 relevant DevOps/Cloud jobs ask for exactly 4: a setting choice, not an error |
| Excluded titles | All 10 are sales, marketing, HR, design or accounting |

## Problems found

| # | Finding | Evidence | Fix |
|---|---|---|---|
| 1 | Title tiers too narrow | Senior Kubernetes Engineer scored 74 but fell in "other" (threshold 75); Cloud Solutions Engineer the same; LinkedIn listed M365 and Cloud Administrator, Data Center Implementation Engineer, SOC Analyst L1, IMS Back Office Engineer, all dropped before scoring | `config/titles.yaml`: Kubernetes, DevSecOps, cloud solutions/platform/administrator → P1; data center, SOC, back office, M365 → P2; hyphenated help-desk |
| 2 | IT support/helpdesk ranked below what Ahmed applies to | He applied to 6 support/helpdesk jobs (fit 48–66); IT Support (Hitachi Rail, 53) was skipped and he rescued it by hand | IT support/specialist/administrator and help/service desk → P1 (threshold 45) |
| 3 | "Senior" jobs prepared that he never wants | 8 Senior/Lead/Manager jobs turned down without applying, 0 applied | Learned suggestion "skip senior titles unless ≤ 2 years" (D42), his choice |
| 4 | Learning ignored Rejected and applications | Only "Not a fit" was learned from | Learns from jobs turned down without applying and from applications below threshold (D42) |
| 5 | 20 jobs went Applied → Rejected the next day | Status history | **Open question for Ahmed:** company rejections, or a way to dismiss? Learning doesn't count them either way |

## Verdict

Collection is complete: nothing was missed in any source in the windows checked. The time limit and
the hard filters were right in every case checked. The errors were in **which titles count as his**,
and the evidence for that came from his own applications. With fixes 1–4 the agent prepares what he
applies to and learns from what he turns down, with each new rule approved by him.

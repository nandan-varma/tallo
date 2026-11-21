# Source audit — 2026-11-20

Live guarded-API probes reconfirmed 65 configured boards as HTTP 404: 61 of the 62 boards
previously marked dead, plus the four failures from the completed sweep. Their configs were removed.
`greenhouse:qualifieddigital` has recovered (first live posting `5464513008`); it stays configured
and should be revived and synced by the main agent. No production data was changed during this audit.

## New verified employer boards

Discovered from indexed employer job pages, then validated against the existing ATS collectors.
Each nonempty board below passed a five-posting `verifySource` sample (or all postings if fewer than five),
with no warnings or mapping issues. Counts here are sampled postings, not full board totals.

| Source                                        | Employer                                 | Sampled | Example title                                                                             |
| --------------------------------------------- | ---------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| recruitee:constructivedialogue                | Constructive Dialogue Institute          |       3 | Associate Director of Program Implementation                                              |
| recruitee:envipco                             | Envipco                                  |       5 | Field Service Manager (Regional)                                                          |
| recruitee:trackman                            | Trackman                                 |       5 | Field Operations Specialist                                                               |
| recruitee:topicsoftwaredevelopment            | TOPIC                                    |       3 | Senior Software Engineer                                                                  |
| recruitee:optics11                            | Optics11                                 |       5 | Product & Trade Compliance Manager                                                        |
| recruitee:lansweeper                          | Lansweeper                               |       5 | Senior Engineering Manager                                                                |
| recruitee:technicaelectronics                 | Technica Electronics                     |       5 | FPGA Engineer (Mid/Intermediate Level)                                                    |
| recruitee:techwolf                            | TechWolf                                 |       5 | Product Marketing Manager                                                                 |
| recruitee:emergentsoftware                    | Emergent Software                        |       5 | IT Support Technician                                                                     |
| recruitee:erstedigital                        | Erste Digital                            |       5 | Student Part-time Software Engineer (all humans) #java #payments                          |
| recruitee:aftershoot                          | Aftershoot                               |       5 | Lead- New Initiatives                                                                     |
| recruitee:virtuslab2                          | VirtusLab                                |       5 | Senior Tooling Engineer                                                                   |
| recruitee:nyrahealth                          | nyra health                              |       5 | Machine Learning Researcher                                                               |
| recruitee:imnoo                               | Imnoo                                    |       5 | Machine Learning / Computer Graphics Engineer (remote part/full time) - Junior/Mid/Senior |
| recruitee:machinelearningreply                | Machine Learning Reply                   |       5 | Machine Learning Consultant (m/w/d)                                                       |
| teamtailor:luminorbank                        | Luminor Bank                             |       5 | DevOps Engineer                                                                           |
| teamtailor:clinisys                           | Clinisys                                 |       5 | Sales Quoting Specialist                                                                  |
| teamtailor:huaweiresearchcentergermanyaustria | Huawei Research Center Germany & Austria |       5 | Industrial PhD Student in System Software Research                                        |
| teamtailor:vuonogroup                         | Vuono Group                              |       5 | Associate Full Stack Data Scientist (entry-level)                                         |
| teamtailor:incision                           | Incision                                 |       5 | Lead Software Engineer                                                                    |
| teamtailor:leafspace                          | Leaf Space                               |       5 | Senior Backend Software Engineer                                                          |
| teamtailor:multiversecomputing                | Multiverse Computing                     |       5 | Dev Ops Engineer (Mid)                                                                    |
| teamtailor:graviteetopcoltd                   | Gravitee                                 |       5 | Senior Software Engineer                                                                  |

Rejected: Recruitee `safesize` (zero listings); Teamtailor `empower.na` (genuine indexed regional
board, but current collector key validation rejects it; reported for a collector fix, not added).

## Confirmed retired IDs

```text
ashby:alden
ashby:ameba
ashby:beside
ashby:boam
ashby:browserbase
ashby:cedar
ashby:clarity
ashby:cleric
ashby:corridor
ashby:hilberts
ashby:kinetic
ashby:liveitup
ashby:liven
ashby:mandrel
ashby:maple
ashby:nectar-social
ashby:norm-ai
ashby:oso
ashby:reprise
ashby:revive
ashby:sana-roles
ashby:stork
ashby:tavily
ashby:umbrel
ashby:willow-health
greenhouse:accrue
greenhouse:aisquared
greenhouse:amount
greenhouse:aninebing
greenhouse:arkoselabs
greenhouse:bellacanvas
greenhouse:builder
greenhouse:classpass
greenhouse:emtrain
greenhouse:fellow
greenhouse:gigs
greenhouse:goodjobgames
greenhouse:gr8tech
greenhouse:headoutcareers
greenhouse:headoutlinkedin
greenhouse:iterable
greenhouse:jugabet
greenhouse:kunai
greenhouse:linkhealth
greenhouse:overstory
greenhouse:parloa
greenhouse:quip
greenhouse:sxseenterprisesllc
greenhouse:tigergraph
greenhouse:tripwireinteractive
greenhouse:truelayer
greenhouse:tula
greenhouse:viseai
greenhouse:zam
lever:FitifyWorkouts
lever:akabrands
lever:analogfolk
lever:bostonimaging
lever:groupbyinc
lever:jupe
lever:metlife
lever:nuwaves
lever:trio
lever:tryriot
lever:voxy-engen
```

Removing JSON configuration does not remove catalog rows. The main agent must use the reviewed
retirement operation after deployment; never infer closure from a failed listing.

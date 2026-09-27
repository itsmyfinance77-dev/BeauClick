# Scale

Language: English | [نسخهٔ فارسی](Scale.md)

Both language versions have the same scope and status and must be updated together. Neither translation independently authorizes execution. Any discrepancy must be resolved and the owner's decision recorded before implementation.

## BeauClick capacity growth reference plan

Recorded: 2026-09-27

Status: documented at the owner's request; implementation of these packages has not started. This document does not authorize spending, infrastructure procurement, new backlog issues or points, or changes to the current demo scope. Starting either package requires a separate owner decision.

The official package names are:

- **Scale-B1 — Growth foundation and multi-instance readiness**
- **Scale-B2 — Expansion and target-capacity validation**

These are engineering packages, not a renaming of product versions to V4 and V5. They define a proposed delivery path for the capacity-related work in V3.4-D; its other topics remain independent and conditional.

## 1. Baseline and limits of the claims

According to ADR-040, the current architecture is a modular application with two deployable units: API and web. Payments and finance run inside the API; financial isolation relies on database connections, roles, and schemas rather than an independent process. This document's review baseline is V3 at commit `b2477a30de93ccec22233f5c117db653f2b9ece1`. Code and subsequent decisions must be reassessed before execution; this baseline does not require future implementation to use an outdated version.

The initial review for this plan did not find sufficient load-test evidence to demonstrate capacity for 30,000 active users. Correctness tests or contention tests involving a few requests are not capacity tests. Scaling also does not replace outstanding requirements for real payments, settlement, security, and release.

Initial observations requiring investigation:

- Rate-limit state is currently held in each process's memory; multiple instances need coordination.
- Outbox processing runs inside the API and its current processing loop is sequential. Duplicate delivery is possible, and consumers must prevent duplicate effects.
- Finance has a separate connection pool currently capped at five connections. This is not a five-user limit; connection occupancy and transaction duration determine throughput.
- Booking uses transactions, locks, and duplicate-effect controls. Contention capacity for one slot differs from capacity across independent slots.

The aim is to retain the existing engineering investment and improve it based on evidence, not to rewrite the product or automatically turn every module into a microservice.

## 2. Target capacity definition

B2 targets **30,000 concurrently active users**, not merely open connections or registered accounts. Before execution, approve a workload contract covering user think time, operation mix, data volume, user distribution across providers, login rate, booking volume, and payment-provider behavior.

Initial test-design assumptions, not a capacity commitment:

- One action per user every five seconds on average: approximately 6,000 actions per second.
- At an average of two API requests per action: approximately 12,000 requests per second. This multiplier must be measured from the real client; action rate is not request rate.
- Proposed action mix: 65% search and browsing, 20% availability and dashboard reads, 10% messaging and other operations, and 5% booking creation or modification and payment initiation.
- Report static files, images, and external-service request costs separately. Do not automatically infer financial transaction rates from these percentages.

Data volume must represent realistic growth; tests against a small demo database cannot support this claim. Login bursts, a highly popular provider, contention for a single slot, and duplicate callbacks are separate scenarios.

## 3. Scale-B1 — Growth foundation and multi-instance readiness

### Objective and entry conditions

Measure current capacity and remove obstacles to reliable multi-instance operation with the minimum necessary complexity. Entry requires owner authorization, an identified code baseline, an independent test environment, and defined initial-release journeys. Measurement can precede completion of every product feature; public activation remains subject to release requirements.

### Work packages

| ID | Software work | Expected output |
|---|---|---|
| B1-01 | Baseline load tooling and observability; inspect slow queries, lock waits, connections, latency, and event lag | Current-capacity report and reproducible bottlenecks |
| B1-02 | Audit API-local state, shared rate limiting, and restricted proxy trust; inspect login and session refresh behavior | Consistent access-control and rate-limit behavior across instances |
| B1-03 | Database connection management, health checks, graceful shutdown, consistent configuration, and coordinated migrations | Multi-instance deployment without dependence on one process |
| B1-04 | Separate necessary workers from the API within the same repository; safe job claiming, retry backoff, and failed-job handling | Independently executable and recoverable background work |
| B1-05 | Remove durable-file dependence on one instance's disk; inspect the existing independent storage path and selective caching | Consistent file access and prevention of cache-based data leakage |
| B1-06 | Test instance failure, duplicate event delivery, recovery, and rollback | Correctness evidence and an operations runbook |

Separating workers does not necessarily mean introducing a network service or a new database. First separate the execution boundary while retaining contracts and data ownership. Multi-instance scheduling must be explicitly checked to avoid duplicate effects or unnecessary load from concurrent execution.

Redis is an option for shared state, not a final technology decision in this document. Caches or distributed locks must not replace the authoritative booking store or financial ledger. Failure of the rate-limit store must have defined and tested behavior; unrestricted request admission is not an accepted solution.

### Completion criteria

- Initial-release capacity has been measured for a specified infrastructure and code version; B1 has no fixed guaranteed user count.
- At least two API instances are tested with coordinated controls, and losing one does not lose committed operations.
- Retries and duplicate callbacks do not create duplicate financial effects or unauthorized duplicate bookings in the test scenarios.
- Latency, errors, connection waits, and queues are observable; recovery and rollback are exercised in practice.
- An independent review report, limitations, and environment costs are recorded. Completing B1 does not automatically authorize B2.

## 4. Scale-B2 — Expansion and target-capacity validation

### Objective and entry conditions

Demonstrate the 30,000-active-user target under an approved workload contract. Prerequisites are acceptance of B1 outputs, a business need or documented growth forecast, an approved budget and operations owner, and approved performance criteria. Neither package starts merely because time has passed.

### Work packages

| ID | Software work | Selection condition or outcome |
|---|---|---|
| B2-01 | Optimize queries, indexes, pagination, and redundant client requests | Based on measured expensive paths |
| B2-02 | Read models and report summaries; isolate reporting load from booking and financial writes | Data-freshness contracts and rebuildability from the authoritative source |
| B2-03 | Scale workers, backpressure, priorities, and bounded queues | No persistent backlog; reporting load does not starve critical work |
| B2-04 | Shorten transactions and reduce lock waits in booking and payment | Preserve capacity controls, lock ordering, and duplicate-effect prevention |
| B2-05 | Expand search, index updates, and caching with invalidation rules | Defined freshness; final slot confirmation still uses the authoritative source |
| B2-06 | Selectively use read replicas or extract a high-traffic module | Only after proving a bottleneck and assessing consistency costs |
| B2-07 | Target-load, soak, spike, and controlled-failure tests | Capacity evidence package and data/financial reconciliation report |

Booking, orders, and payments are not separated merely to increase the number of services. Every extraction must explain transaction boundaries, contracts, migration, recovery, and operational costs. Financial-ledger access isolation must be preserved in every design.

### Proposed tests and acceptance criteria

The following are initial proposals requiring approval before execution, not the product's current SLA:

- p95 response time below one second for primary reads and search, and below two seconds for internal booking creation; report external-service latency separately. Record p99 and set its threshold before testing.
- Unexpected server error rate below 0.1%; count correct business responses, such as a slot being full, separately.
- Accept no unexplained financial discrepancy, duplicate financial effect, or booking beyond capacity in the tests. Passing tests does not establish that future errors are impossible.
- Approve numerical limits for queue lag, drain time after a spike, recovery time, and maximum tolerable data loss before execution; define financial-data recovery objectives separately.
- Increase load through 100, 500, 1,000, 3,000, 5,000, 10,000, 15,000, and 30,000 users. Passing one step does not certify the next.
- Initial proposal: at least four hours at target load, a 24-hour soak at an agreed load, and a 1.5x spike for ten minutes; approve final duration and costs before execution.
- Test API/worker failure, payment-provider slowness, duplicate callbacks, single-slot contention, and database recovery in proportion to the availability objective.

Run the load generator on a separate host. Do not run heavy tests on the presentation host or shared resources without a separate plan. Use synthetic data and generate no real payments or messages. Do not infer real-provider behavior or limits from simulator tests; authorized provider-sandbox tests and real activation requirements are separate.

### Final deliverable

The report must include code SHA, configuration, topology, data volume, load scripts, actual request rate, operation distribution, latency, errors, resource utilization, queue state, and financial reconciliation results. Record costs and capacity headroom as well. Independent approval applies to this specific version/environment combination; material changes require reassessment.

## 5. Relationship to V3.4-D

| Existing topic | Place in Scale |
|---|---|
| Shared Redis | A B1 option for demonstrated coordination and rate-limit needs |
| Queues and workers / Kafka | Necessary worker separation in B1; Kafka only if B2 evidence shows simpler tools are insufficient |
| Analytics / ClickHouse | Summaries and read isolation in B2; ClickHouse is not an automatic choice |
| Kubernetes and multi-region | Outside the default B1/B2 commitment; require a separate availability- and cost-based decision |
| Machine-learning ranking | Outside these packages; subject to data, evaluation, and product decisions |

V3.4-D is neither removed nor replaced. This document only turns its capacity-growth portion into two trackable packages.

## 6. Recommended sequencing relative to V3.3 and V3.4

The engineering recommendation is neither to require all of V3.3/V3.4 before Scale nor to put scaling ahead of release requirements. Version numbers alone do not create implementation dependencies.

1. First complete and review the current demo and active commitments under their existing plans; do not add Scale to their scope.

2. Before real release, complete only the requirements essential to the intended market and business model in V3.3 and preceding stages: booking/payment correctness, necessary refunds and settlement, access control, privacy, recovery, and external requirements. Reconcile the exact list with the live backlog; this document does not claim that all these items are either complete or open. Scale does not remove any legal/financial dependency or gate, including the #176/#177 chain.

3. B1 measurement can start earlier so the pilot does not begin with unknown capacity. Select B1 changes according to evidence and release needs. Full B1 completion is not a universal prerequisite for a small pilot, but relevant controls must be completed before multi-instance deployment.

4. After the pilot, schedule valuable V3.3 features and B1 capacity improvements according to product priorities. Concurrent planning does not authorize parallel execution or heavy builds on a shared host.

5. Start B2 when growth or a business commitment justifies it. Native apps, video, a multi-vendor marketplace, or advanced AI in V3.4 do not all have to be implemented first. If any such feature is added before target testing, update the workload contract.

In short: **release essentials and initial measurement → pilot and needs-based B1 → market growth and selected product development → B2 when supported by documented need**. This is a recommendation, not an approved reprioritization of the entire backlog.

## 7. Limits of effort estimates

In planning discussions, treating total V3 engineering effort as 100 units, approximately 15–25 units were suggested for B1 and 30–50 units for B1+B2 combined. These are preliminary, low-confidence estimates, not story points, percentages of lines of code, calendar durations, or an approved budget. Estimate B2 independently after B1; do not create a delivery commitment by simply subtracting the two ranges.

Hardware and provider costs, business-feature completion, and release requirements are excluded from these ratios. A need for deep redesign or database partitioning could change the estimates. After gap analysis, break each package into estimable deliverables.

## 8. Decisions required before execution

- Business owner: approve market scope, capacity target, priority, and budget.
- Technical owner: document the baseline, workload contract, tool choices, and migration plan.
- Operations owner: accept the environment, monitoring, recovery, costs, and maintenance responsibilities.
- Independent reviewer: assess evidence for the specific version; the implementer does not certify capacity alone.
- For each package, record latency, recovery, queue, and cost limits before final testing; do not turn unsupported technology choices into commitments.

## Project references

- [V3.4-D and current roadmap sequencing](v3.2/V3.2_PRODUCT_ROADMAP.md)
- [Capability catalog and expansion conditions](v3.2/V3.2_PLUS_CAPABILITY_CATALOG.md)
- [ADR-040: Current deployment topology](v3/adr/ADR-040-current-deployment-topology.md)
- [ADR-017: Financial isolation](v3/adr/ADR-017-financial-isolation-and-money.md)
- [Current outbox processing](../../v3/libs/events/src/outbox.relay.ts)
- [Current rate-limit storage status](../../v3/apps/api/src/health/readiness.service.ts)
- [Separate financial connection](../../v3/apps/api/src/composition/financial-datasource.provider.ts)

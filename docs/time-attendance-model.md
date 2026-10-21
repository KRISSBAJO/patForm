# Time & Attendance for Patform

## Product decision

Build this as an optional **Time & Attendance** module beside HR, not as a form or a hidden HR tab. HR supplies people, managers, branches, employment status and compensation references. Patform's approval engine handles exception decisions. The phone app (`/go`) is the main employee surface; the console is for scheduling, review and payroll close.

The central rule is: **a schedule says what was planned; clock events say what was observed; approval says what is accepted; payroll says what is payable.** None of these records silently rewrites another. A manager declining an unscheduled shift cannot erase a genuine clock event or automatically declare the time unpaid.

## Employee journey

1. `/go` shows a compact, contextual Workday card. The primary button is **Clock in**, **Start break**, **End break**, or **Clock out**, as appropriate. Opening the app never records a clock event.
2. The clock action displays the selected shift, local workplace time and any location requirement before confirmation. With two plausible shifts, the employee chooses. With none, they give a short reason; their time starts recording while an exception is sent for review.
3. The live card shows actual start, scheduled end, elapsed time, breaks and a plainly named status such as **Working**, **On break**, or **Needs review**. A timer is a display projection, not a stored event.
4. Clock out presents actual start and end, unpaid breaks and calculated work duration. The employee can report a missing or incorrect event. Submitted corrections show both old and proposed values.
5. **My time** separates recorded hours, approved payable hours and pending review. Earnings are estimates until payroll closes. Completed periods remain readable to the employee.

## Manager and payroll journey

- Managers get one queue ordered by risk: missing clock-out, overlaps, wrong site, unscheduled starts, unusual duration, break issues and correction requests. Routine exceptions are bundled; urgent alerts are reserved for configured safety or operational cases.
- Each decision has a reason, actor and timestamp. A manager may link attendance to a shift, approve a new shift, request information or reject the schedule exception. The underlying clock events remain intact.
- A pay period follows **resolve exceptions → approve timesheets → calculate pay → approve payroll → export**. A closed period is immutable. Later corrections create a dated adjustment for a later pay run.
- Compensation has effective-dated rates by employee, role and location. Salary, hourly work, premiums, commissions, tips and allowances stay as separate components. Booked appointment hours never substitute for attendance hours.

## Records and rules

| Record | Purpose |
| --- | --- |
| Shift | Planned interval, role, branch, assigned employee, version and swap/approval history. |
| Clock event | Append-only in/out/break start/break end, server receipt time, client capture time, method, device and idempotency key. |
| Work session | Projection from clock events; may span midnight and daylight-saving changes. Always stores UTC instants and the workplace time zone. |
| Exception | A distinct review case with type, explanation, evidence, policy version, decision and notification state. |
| Timesheet | Period snapshot of actual and approved minutes, reviewer and approval history. |
| Pay run | Frozen inputs, effective rates, calculated components, export version and subsequent adjustments. |

Server-side invariants: one open session per employee; an event cannot be used twice; clock-in is an explicit action; offline submissions use stable idempotency keys and retain capture and receipt times; a sync conflict is reviewed instead of silently reconciled; supervisors cannot approve their own corrections; finalized payroll cannot be overwritten. Every read and write is scoped to the workspace and the employee's permitted branch/team.

## Policy choices, not hard-coded assumptions

The workspace configures early/late windows, break types, overtime and premium rules, time-zone and location checks, maximum shift length, pay periods, correction authority, and retention. Rules are versioned so a policy change does not recalculate historical pay without an explicit adjustment. Location is checked at a clock event when enabled; continuous tracking is outside the default experience. A kiosk or QR code records the same events and permissions as `/go`.

Jurisdiction-specific pay and working-time rules need a reviewed configuration before payroll export is used for real wages. The design follows the principle of retaining actual hours and the basis of pay: see the [US Department of Labor's recordkeeping guidance](https://www.dol.gov/agencies/whd/fact-sheets/21-flsa-recordkeeping?lang=en), [UK working-time record requirements](https://www.legislation.gov.uk/uksi/1998/1833/regulation/9), and [ICO guidance on monitoring workers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/data-protection-and-monitoring-workers?search=DPIA).

## Release order

1. **Attendance ledger:** shifts, `/go` Workday, clock events, breaks, overnight matching, unscheduled sessions, employee history and manager exception queue.
2. **Timesheet close:** corrections, approval, period snapshots and an audit trail that both employee and manager can inspect.
3. **Pay bridge:** effective-dated rates, configurable pay rules, estimated earnings, approved payroll export and immutable adjustments.
4. **Additional channels:** offline capture, kiosk and QR, each using the same event API and conflict rules.

Do not describe the first release as a payroll system until pay rules, export reconciliation and jurisdiction checks are ready. The first employee action should still take about two taps: open Workday, then confirm clock-in.

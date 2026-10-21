# Time & Attendance release

Time & Attendance is an optional workspace module. A workspace administrator switches it on in Modules & workspace. Pre-hire accounts cannot record time. Opening `/go` or signing in never clocks someone in, and signing out never clocks someone out.

## Employee journey

The Workday panel on `/go` shows the matching scheduled shift, current state and explicit clock actions. A start more than 15 minutes early or late is recorded with a timing exception for manager review. Without a matching shift, the employee supplies a reason and the workday is recorded with a schedule exception. The console's **My records** view shows completed days and lets the employee request a correction. A correction preserves the observed clock events.

## Manager journey

Managers schedule shifts and decide schedule exceptions and correction requests for their reporting team. A declined schedule exception does not erase observed time. A workspace administrator creates a review period. Managers approve their team members' timesheets after open workdays, pending exceptions and pending corrections are resolved. A person cannot approve their own time.

Once the period ends, an administrator finalizes it and exports approved hours as CSV. Finalization freezes each approved timesheet. A correction approved after finalization creates a separate adjustment row with a stable ID in the CSV; it never rewrites the original approval. Match adjustment IDs in downstream payroll to avoid importing the same row twice.

## Payroll boundary

The CSV provides approved seconds, recorded seconds, employee IDs and optional payroll references. It is **payroll input**, not a payslip, wage calculation, tax calculation or payment instruction. Rates, overtime, salary, allowances, commissions and jurisdiction-specific rules must be checked in the payroll system before money is released. The module does not automatically infer payable hours from a scheduled shift.

## Release checks

Run `node --env-file=.env node_modules/tsx/dist/cli.mjs --test tests/attendance.test.ts` against a local test database. The tests cover duplicate clock actions, scheduled and unscheduled starts, break events, preserved clock history, manager-only decisions, approved timesheet snapshots, closed periods and post-close adjustment exports.

On staging, enable the module only for a test workspace and verify `/go` on a phone, employee correction submission, manager review, period finalization and the downloaded CSV before enabling it for a working team.

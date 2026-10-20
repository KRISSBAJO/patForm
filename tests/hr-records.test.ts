import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPool, type Pool } from '../src/runtime/db.js';
import { Engine } from '../src/runtime/engine.js';
import { setModule } from '../src/runtime/modules.js';
import { setManager, setMemberPlacement, createOrgUnit } from '../src/runtime/org.js';
import { memoryObjectStore, setObjectStoreForTests } from '../src/runtime/object-store.js';
import { createDocument, listCompensation, listEmployees, myDocuments, readHrSettings, requestLeave, saveHoliday, saveLeaveType, sendDocument, setCompensation, setTeamMember, startOnboarding, updateHrSettings } from '../src/runtime/hr.js';
import { addEmployeeEvent, adjustLeave, documentFileLink, employeeDetail, employeeFileLink, leaveCalendar, leaveLedger, listBranches, myProfile, orgTree, saveBranch, setEmployeeBranch, updateProfile, uploadDocumentFile, uploadEmployeeFile } from '../src/runtime/hr-records.js';
import type { Principal } from '../src/runtime/policy.js';

const localDatabase = !!process.env.DATABASE_URL && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname);
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n').toString('base64');

async function workspace(pool: Pool, engine: Engine) {
  const tenantId = await engine.createTenant(`hr-records-${stamp()}`, { scenario: true });
  const mk = async (name: string, role: 'owner' | 'admin' | 'operator' | 'approver' | 'read_only') => {
    const id = await engine.createActor(tenantId, `${name.toLowerCase().replace(/\s+/g, '.')}-${stamp()}@hr.test`, name, role);
    await pool.query('update actor set email_verified_at = now() where id = $1', [id]);
    return { id, p: { kind: 'actor', tenantId, actorId: id } as Principal };
  };
  const owner = await mk('Owner', 'owner');
  const hrClerk = await mk('Hugo Clerk', 'operator');
  const manager = await mk('Mo Manager', 'approver');
  const staff = await mk('Sam Staff', 'read_only');
  const peer = await mk('Pat Peer', 'read_only');
  const outsider = await mk('Olu Other', 'read_only');
  await setModule(pool, owner.p, 'hr', { enabled: true });
  await setTeamMember(pool, owner.p, { team: 'hr', actorId: hrClerk.id });
  const unit = await createOrgUnit(pool, owner.p, { name: 'Field' });
  for (const a of [manager, staff, peer]) await setMemberPlacement(pool, owner.p, a.id, { unitId: unit.id });
  await setManager(pool, owner.p, staff.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  await setManager(pool, owner.p, peer.id, { managerId: manager.id, effectiveFrom: '2026-01-01T00:00:00Z' });
  const emp = async (actorId: string, start: string) => (await pool.query<{ id: string }>(
    `insert into employee_record (tenant_id, actor_id, email, name, status, start_date) select $1, id, email, display_name, 'active', $3 from actor where id = $2 returning id`, [tenantId, actorId, start])).rows[0]!.id;
  const staffId = await emp(staff.id, '2025-03-10');
  const peerId = await emp(peer.id, '2024-06-01');
  return { tenantId, owner, hrClerk, manager, staff, peer, outsider, staffId, peerId };
}

test('the record: HR sees everything, the manager the basics and manager notes, the person their own details and what HR shared', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await workspace(pool, new Engine(pool));
    // The person fills in their own contact and emergency details; HR-only fields are refused.
    await updateProfile(pool, w.staff.p, w.staffId, { phone: '+234 800 000 0001', emergencyName: 'Ada Staff', emergencyPhone: '+234 800 000 0002', emergencyRelation: 'Sister' });
    await assert.rejects(updateProfile(pool, w.staff.p, w.staffId, { grade: 'G7' }), /only HR can change grade/);
    await assert.rejects(updateProfile(pool, w.manager.p, w.staffId, { phone: 'x' }), /only HR or the person/);
    await updateProfile(pool, w.hrClerk.p, w.staffId, { grade: 'G7', workPattern: 'Mon–Fri, 9 to 5', dateOfBirth: '1990-04-12' });
    // Notes with visibility.
    await addEmployeeEvent(pool, w.hrClerk.p, w.staffId, { kind: 'warning', title: 'Verbal warning: lateness', visibility: 'hr' });
    await addEmployeeEvent(pool, w.manager.p, w.staffId, { kind: 'recognition', title: 'Closed the Abuja deal', visibility: 'employee' });
    await assert.rejects(addEmployeeEvent(pool, w.manager.p, w.staffId, { kind: 'warning', title: 'x' }), /only HR records a warning/);
    await assert.rejects(addEmployeeEvent(pool, w.staff.p, w.staffId, { kind: 'note', title: 'x' }), /only HR or your manager/);
    // A file: a contract HR keeps, and a letter the person may see.
    const contract = await uploadEmployeeFile(pool, w.hrClerk.p, w.staffId, { category: 'contract', title: 'Employment contract', filename: 'contract.pdf', base64: PDF });
    const letter = await uploadEmployeeFile(pool, w.hrClerk.p, w.staffId, { category: 'letter', title: 'Confirmation letter', filename: 'letter.pdf', base64: PDF, employeeCanSee: true });
    await assert.rejects(uploadEmployeeFile(pool, w.manager.p, w.staffId, { category: 'other', filename: 'x.pdf', base64: PDF }), /only HR/);
    await assert.rejects(uploadEmployeeFile(pool, w.hrClerk.p, w.staffId, { category: 'other', filename: 'x.exe', base64: Buffer.from('MZ....').toString('base64') }), /PDF, Word/);

    const hrView = await employeeDetail(pool, w.hrClerk.p, w.staffId);
    assert.equal(hrView.tier, 'hr');
    assert.equal(hrView.profile.grade, 'G7');
    assert.equal(hrView.profile.emergency_name, 'Ada Staff');
    assert.equal(hrView.profile.manager_name, 'Mo Manager');
    assert.deepEqual(hrView.files.map((f: { title: string }) => f.title).sort(), ['Confirmation letter', 'Employment contract']);
    assert.ok(hrView.events.some((e: { title: string }) => e.title.startsWith('Verbal warning')));
    assert.ok(hrView.timeline.some((t) => t.kind === 'joined' && t.on === '2025-03-10'));
    assert.ok(hrView.timeline.some((t) => t.kind === 'manager' && t.title === 'Reports to Mo Manager'));
    assert.ok(hrView.timeline.some((t) => t.kind === 'file' && t.title === 'Employment contract'));

    const mView = await employeeDetail(pool, w.manager.p, w.staffId);
    assert.equal(mView.tier, 'manager');
    assert.equal(mView.profile.emergency_name, undefined, 'the manager does not get emergency contacts');
    assert.equal(mView.profile.date_of_birth, undefined);
    assert.equal(mView.files.length, 0);
    assert.deepEqual(mView.events.map((e: { title: string }) => e.title), ['Closed the Abuja deal']);
    assert.ok(!JSON.stringify(mView).includes('Verbal warning'));

    const me = await myProfile(pool, w.staff.p);
    assert.equal(me.tier, 'self');
    assert.equal(me.profile.phone, '+234 800 000 0001');
    assert.deepEqual(me.files.map((f: { title: string }) => f.title), ['Confirmation letter']);
    assert.deepEqual(me.events.map((e: { title: string }) => e.title), ['Closed the Abuja deal']);
    assert.ok(!JSON.stringify(me).includes('Verbal warning'));
    assert.equal(me.cases.length, 0);

    await assert.rejects(employeeDetail(pool, w.outsider.p, w.staffId), /no such employee/);
    await assert.rejects(employeeDetail(pool, w.peer.p, w.staffId), /no such employee/);

    // Links: HR opens both; the person only the shared one; a quarantined file is refused.
    assert.match((await employeeFileLink(pool, w.hrClerk.p, contract.id)).url, /hr\/files/);
    assert.equal((await employeeFileLink(pool, w.staff.p, letter.id)).filename, 'letter.pdf');
    await assert.rejects(employeeFileLink(pool, w.staff.p, contract.id), /no such file/);
    mem.scans.set(`hr/files/${w.tenantId}/${letter.id}`, 'quarantined');
    await assert.rejects(employeeFileLink(pool, w.staff.p, letter.id), /malware/);
  } finally { setObjectStoreForTests(undefined); await pool.end(); }
});

test('documents carry a file: HR attaches it, people it was sent to open it, nobody else', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  const mem = memoryObjectStore(); setObjectStoreForTests(mem.store);
  try {
    const w = await workspace(pool, new Engine(pool));
    const doc = await createDocument(pool, w.hrClerk.p, { title: 'Code of conduct', version: '3', kind: 'agreement' });
    await assert.rejects(documentFileLink(pool, w.hrClerk.p, doc.id), /no file attached/);
    const up = await uploadDocumentFile(pool, w.hrClerk.p, doc.id, { filename: 'code-of-conduct-v3.pdf', base64: PDF });
    assert.equal(up.filename, 'code-of-conduct-v3.pdf');
    await sendDocument(pool, w.hrClerk.p, doc.id, { employeeIds: [w.staffId] });
    assert.equal((await myDocuments(pool, w.staff.p))[0]!.title, 'Code of conduct');
    assert.match((await documentFileLink(pool, w.staff.p, doc.id)).url, /hr\/documents/);
    await assert.rejects(documentFileLink(pool, w.peer.p, doc.id), /no such document/);
    const me = await myProfile(pool, w.staff.p);
    assert.equal(me.documents[0]!.has_file, true);
  } finally { setObjectStoreForTests(undefined); await pool.end(); }
});

test('leave: monthly accrual, carry-over up to the cap, adjustments with a reason, and a calendar scoped to what you may see', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const w = await workspace(pool, new Engine(pool));
    const year = new Date().getUTCFullYear(); const month = new Date().getUTCMonth() + 1;
    // Annual leave accrues monthly and carries over up to 5 days.
    await saveLeaveType(pool, w.owner.p, { key: 'annual', name: 'Annual leave', annualDays: 24, accrualMode: 'monthly', carryOverMax: 5 });
    // Pat (started 2024) took 10 of 24 last year: 14 unused, 5 carry over. Sam started 2025, took nothing last year: 5 carry over too.
    const { rows: t } = await pool.query<{ id: string }>('select id from leave_type where tenant_id = $1 and key = $2', [w.tenantId, 'annual']);
    await pool.query(`insert into leave_request (tenant_id, employee_id, leave_type_id, start_date, end_date, days, status) values ($1, $2, $3, $4, $5, 10, 'approved')`,
      [w.tenantId, w.peerId, t[0]!.id, `${year - 1}-02-03`, `${year - 1}-02-14`]);
    let ledger = await leaveLedger(pool, w.hrClerk.p, w.peerId, year);
    let annual = ledger.balances.find((b) => b.key === 'annual')!;
    assert.equal(annual.entitled, 24);
    assert.equal(annual.accrued, Math.round(24 * month / 12 * 2) / 2);
    assert.equal(annual.carriedOver, 5);
    assert.equal(annual.left, annual.accrued + 5);
    // HR adds 2 days in lieu with a reason; a deduction is a negative number.
    await assert.rejects(adjustLeave(pool, w.hrClerk.p, { employeeId: w.peerId, type: 'annual', year, days: 2 }), /say why/);
    await assert.rejects(adjustLeave(pool, w.manager.p, { employeeId: w.peerId, type: 'annual', year, days: 2, reason: 'x' }), /only HR/);
    await adjustLeave(pool, w.hrClerk.p, { employeeId: w.peerId, type: 'annual', year, days: 2, reason: 'Worked the public holiday' });
    await adjustLeave(pool, w.hrClerk.p, { employeeId: w.peerId, type: 'annual', year, days: -1, reason: 'Unpaid day agreed' });
    ledger = await leaveLedger(pool, w.peer.p, null, year);
    annual = ledger.balances.find((b) => b.key === 'annual')!;
    assert.equal(annual.adjusted, 1);
    assert.equal(annual.left, annual.accrued + 5 + 1);
    assert.equal(ledger.adjustments.length, 2);
    // The person sees their own ledger; a peer cannot see another's.
    await assert.rejects(leaveLedger(pool, w.peer.p, w.staffId, year), /no such employee/);
    // Proration for a first year, upfront.
    await saveLeaveType(pool, w.owner.p, { key: 'study', name: 'Study leave', annualDays: 12, prorateFirstYear: true });
    const { rows: fresh } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, email, name, status, start_date) values ($1, $2, 'Newbie', 'active', $3) returning id`, [w.tenantId, `newbie-${stamp()}@hr.test`, `${year}-07-15`]);
    const study = (await leaveLedger(pool, w.hrClerk.p, fresh[0]!.id, year)).balances.find((b) => b.key === 'study')!;
    assert.equal(study.entitled, 6, 'July start: six of twelve months');

    // The calendar: Sam asks for leave next week; the manager and the unit see it, an outsider does not, HR sees everyone.
    const start = addDays(7); const end = addDays(9);
    const r = await requestLeave(pool, w.staff.p, { type: 'annual', startDate: start, endDate: end });
    assert.ok(r.days >= 1);
    const m = start.slice(0, 7);
    const hrCal = await leaveCalendar(pool, w.hrClerk.p, m);
    assert.equal(hrCal.scope, 'workspace');
    assert.ok(hrCal.away.some((a) => a.name === 'Sam Staff' && a.status === 'requested'));
    const mCal = await leaveCalendar(pool, w.manager.p, m);
    assert.ok(mCal.away.some((a) => a.name === 'Sam Staff'));
    const peerCal = await leaveCalendar(pool, w.peer.p, m);
    assert.ok(peerCal.away.some((a) => a.name === 'Sam Staff' && !a.mine), 'same unit sees who is away');
    const outCal = await leaveCalendar(pool, w.outsider.p, m);
    assert.equal(outCal.away.length, 0);
    await assert.rejects(leaveCalendar(pool, w.hrClerk.p, '2026-1'), /YYYY-MM/);
  } finally { await pool.end(); }
});

test('the org chart is a tree of who reports to whom, with the employee record alongside', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const w = await workspace(pool, new Engine(pool));
    await setManager(pool, w.owner.p, w.manager.id, { managerId: w.owner.id, effectiveFrom: '2026-01-01T00:00:00Z' });
    const org = await orgTree(pool, w.staff.p);
    const ownerNode = org.tree.find((n) => n.name === 'Owner')!;
    assert.ok(ownerNode, 'the owner is a root');
    const mo = ownerNode.reports.find((n) => n.name === 'Mo Manager')!;
    assert.deepEqual(mo.reports.map((n) => n.name).sort(), ['Pat Peer', 'Sam Staff']);
    assert.equal(mo.reports.find((n) => n.name === 'Sam Staff')!.unit, 'Field');
    assert.equal(mo.reports.find((n) => n.name === 'Sam Staff')!.status, 'active');
    assert.equal(org.units[0]!.name, 'Field');
    assert.equal(org.canEdit, false);
    assert.equal((await orgTree(pool, w.hrClerk.p)).canEdit, true);
    // An onboarding shows up as a pre-hire under their manager.
    await startOnboarding(pool, w.hrClerk.p, { email: `nora-${stamp()}@hr.test`, name: 'Nora New', startDate: addDays(5), managerId: w.manager.id });
    const after = await orgTree(pool, w.hrClerk.p);
    const mo2 = after.tree.find((n) => n.name === 'Owner')!.reports.find((n) => n.name === 'Mo Manager')!;
    assert.ok(mo2.reports.some((n) => n.name === 'Nora New' && n.status === 'pre_hire'));
  } finally { await pool.end(); }
});

test('branches: a company in several countries, each with its own currency, working week and holidays', { skip: !localDatabase }, async () => {
  const pool = createPool(3);
  try {
    const w = await workspace(pool, new Engine(pool));
    // The workspace default is set by an HR admin; nothing assumes a country.
    assert.equal((await readHrSettings(pool, w.owner.p)).defaultCurrency, 'USD');
    await updateHrSettings(pool, w.owner.p, { defaultCurrency: 'gbp', defaultCountry: 'gb' });
    await assert.rejects(updateHrSettings(pool, w.owner.p, { defaultCurrency: 'pounds' }), /three-letter ISO code/);
    // Two branches: Lagos works Monday to Friday in naira; Dubai works Sunday to Thursday in dirhams.
    await assert.rejects(saveBranch(pool, w.hrClerk.p, { name: 'Lagos', country: 'NG', currency: 'NGN' }), /owner or admin/);
    const lagos = await saveBranch(pool, w.owner.p, { name: 'Lagos', country: 'ng', currency: 'ngn', timezone: 'Africa/Lagos' });
    const dubai = await saveBranch(pool, w.owner.p, { name: 'Dubai', country: 'AE', currency: 'AED', timezone: 'Asia/Dubai', workingDays: [7, 1, 2, 3, 4] });
    await assert.rejects(saveBranch(pool, w.owner.p, { name: 'lagos', country: 'NG', currency: 'NGN' }), /already a branch/);
    await assert.rejects(saveBranch(pool, w.owner.p, { name: 'Nairobi', country: 'KE', currency: 'KES', timezone: 'Mars/Olympus' }), /IANA/);
    const list = await listBranches(pool, w.staff.p);
    assert.deepEqual(list.branches.map((b: { name: string }) => b.name), ['Dubai', 'Lagos']);
    assert.equal(list.defaultCurrency, 'GBP');
    assert.equal(list.canEdit, false);
    // People are placed in a branch; pay takes the branch currency unless one is given.
    await setEmployeeBranch(pool, w.hrClerk.p, w.staffId, { branchId: lagos.id });
    await setEmployeeBranch(pool, w.hrClerk.p, w.peerId, { branchId: dubai.id });
    await setCompensation(pool, w.owner.p, w.staffId, { amount: 4800000, effectiveFrom: '2026-01-01' });
    await setCompensation(pool, w.owner.p, w.peerId, { amount: 180000, effectiveFrom: '2026-01-01' });
    const { rows: fresh } = await pool.query<{ id: string }>(`insert into employee_record (tenant_id, email, name, status, start_date) values ($1, $2, 'No Branch', 'active', '2026-01-05') returning id`, [w.tenantId, `nobranch-${stamp()}@hr.test`]);
    await setCompensation(pool, w.owner.p, fresh[0]!.id, { amount: 52000, effectiveFrom: '2026-01-05' });
    assert.equal((await listCompensation(pool, w.owner.p, w.staffId))[0]!.currency, 'NGN');
    assert.equal((await listCompensation(pool, w.owner.p, w.peerId))[0]!.currency, 'AED');
    assert.equal((await listCompensation(pool, w.owner.p, fresh[0]!.id))[0]!.currency, 'GBP', 'no branch: the workspace default');
    const staffRow = (await listEmployees(pool, w.hrClerk.p)).find((e: { id: string }) => e.id === w.staffId)!;
    assert.equal(staffRow.branch_name, 'Lagos');
    assert.equal(staffRow.branch_currency, 'NGN');
    // A holiday in Lagos is not a holiday in Dubai; Dubai's week has Sunday in it and Friday out.
    const year = new Date().getUTCFullYear() + 1;
    const mon = new Date(Date.UTC(year, 2, 1)); while (mon.getUTCDay() !== 1) mon.setUTCDate(mon.getUTCDate() + 1);
    const iso = (n: number) => new Date(mon.getTime() + n * 86400000).toISOString().slice(0, 10);
    await saveHoliday(pool, w.hrClerk.p, { day: iso(1), name: 'Lagos only', branchId: lagos.id });
    await adjustLeave(pool, w.hrClerk.p, { employeeId: w.staffId, type: 'annual', year, days: 20, reason: 'test' });
    await adjustLeave(pool, w.hrClerk.p, { employeeId: w.peerId, type: 'annual', year, days: 20, reason: 'test' });
    const lagosWeek = await requestLeave(pool, w.staff.p, { type: 'annual', startDate: iso(0), endDate: iso(6) });
    assert.equal(lagosWeek.days, 4, 'Monday to Sunday in Lagos: five working days less the Tuesday holiday');
    const dubaiWeek = await requestLeave(pool, w.peer.p, { type: 'annual', startDate: iso(0), endDate: iso(6) });
    assert.equal(dubaiWeek.days, 5, 'Monday to Sunday in Dubai: Monday to Thursday and Sunday; the Lagos holiday does not apply');
    // The branch shows on the record, the org chart and the calendar.
    assert.equal((await employeeDetail(pool, w.manager.p, w.staffId)).profile.branch_name, 'Lagos');
    const org = await orgTree(pool, w.hrClerk.p);
    const sam = org.tree.flatMap((n) => n.reports).find((n) => n.name === 'Sam Staff') ?? org.tree.find((n) => n.name === 'Sam Staff');
    assert.equal(sam?.branch, 'Lagos');
    const cal = await leaveCalendar(pool, w.hrClerk.p, iso(0).slice(0, 7));
    assert.ok(cal.holidays.some((h) => h.name === 'Lagos only' && h.branch === 'Lagos'));
    assert.ok(cal.away.some((a) => a.name === 'Pat Peer' && a.branch === 'Dubai'));
  } finally { await pool.end(); }
});

"""
Generates processes/staff-expense-claim.blueprint.json and
processes/cash-advance.blueprint.json (PRD Module 5) from
processes/expense-approval.blueprint.json.

Run from the repo root:  python -I scripts/make-expense-blueprints.py .
Edit this script, not the generated files.
"""
import json, copy, sys
root = sys.argv[1]
src = json.load(open(f'{root}/processes/expense-approval.blueprint.json', encoding='utf-8'))

def fix_text(o):
    # the source file has mis-encoded pound signs; repair them
    if isinstance(o, str): return o.replace('Â£', '£')
    if isinstance(o, list): return [fix_text(x) for x in o]
    if isinstance(o, dict): return {k: fix_text(v) for k, v in o.items()}
    return o
src = fix_text(src)

# ------------------------------------------------------------ expense claim
c = copy.deepcopy(src)
c['key'] = 'staff_expense_claim'
c['name'] = 'Expense claim'
c['description'] = ("PRD Module 5. A claim routed to the claimant's manager from the directory, with the limits taken "
                    "from Finance settings at the moment it is submitted. A claim can retire a cash advance by quoting its "
                    "reference; Finance then pays only what is still owed. Approval opens a settlement that Finance marks "
                    "paid, failed or void.")
c['intent']['outcome'] = 'A claimed expense is approved at the right level, and Finance records it as paid against a reference.'
policy = [
    {'key': 'policy_auto_approve_limit', 'type': 'number', 'label': 'Auto-approve limit at submission', 'classification': 'internal', 'setBy': 'system'},
    {'key': 'policy_manager_limit', 'type': 'number', 'label': 'Manager limit at submission', 'classification': 'internal', 'setBy': 'system'},
    {'key': 'policy_line_limit', 'type': 'number', 'label': 'Single-item limit at submission', 'classification': 'internal', 'setBy': 'system'},
    {'key': 'fx_rate', 'type': 'number', 'label': 'Exchange rate used', 'classification': 'internal', 'setBy': 'system'},
    {'key': 'approval_amount_base', 'type': 'number', 'label': 'Total in the workspace currency', 'classification': 'confidential', 'setBy': 'system'},
]
currency_field = {'key': 'claim_currency', 'type': 'short_text', 'label': 'Currency of the receipts (optional)', 'classification': 'internal',
                  'constraints': {'maxLength': 3, 'message': 'Use a three-letter code, such as USD.'},
                  'help': 'Leave blank if you paid in the usual currency. Otherwise give the code, such as USD or GBP; Finance converts it at the rate in force today.'}
fields = [f for f in c['data']['fields'] if f['key'] != 'manager_email']
for f in fields:
    if f['key'] == 'receipt_reference':
        f['required'] = False
        f['help'] = 'Upload the receipts or give the reference where Finance can find them. Finance decides above what amount a receipt is needed.'
advance_field = {'key': 'advance_reference', 'type': 'short_text', 'label': 'Advance you are retiring (optional)', 'classification': 'internal',
                 'help': 'If this spending was paid from a cash advance, give its reference, for example ADV-1A2B3C4D. Finance takes it off what you still hold.'}
idx = [f['key'] for f in fields].index('claim_note')
fields.insert(idx, advance_field)
fields.insert([f['key'] for f in fields].index('line_items'), currency_field)
c['data']['fields'] = fields + policy
for page in c['experience']['pages']:
    for sec in page['sections']:
        sec['fields'] = [k for k in sec['fields'] if k != 'manager_email']
        if 'widths' in sec: sec['widths'].pop('manager_email', None)
        if sec['key'] == 'evidence': sec['fields'] = ['receipt_reference', 'advance_reference', 'claim_note']
        if sec['key'] == 'items': sec['fields'] = ['claim_currency', 'line_items']
c['experience']['confirmation']['message'] = 'Your claim has been logged. Small claims are approved straight away; anything larger goes to your manager, and Finance pays it once approved.'
for r in c['roles']:
    if r['key'] == 'claimant' and 'advance_reference' not in r.get('editableFields', []):
        r.setdefault('editableFields', []).append('advance_reference')
for a_ in c['workflow']['approvals']:
    if a_['key'] == 'manager_approval':
        a_['approvers'] = [{'manager': 'submitter', 'fallback': 'line_manager'}]
for t in c['communications']['email']:
    t['to'] = [{'manager': 'submitter', 'fallback': 'line_manager'} if p == {'field': 'manager_email'} else p for p in t['to']]
    t['body'] = t['body'].replace('the £100 threshold', 'the auto-approve limit').replace('It will be paid in the next payment run.', 'Finance will record the payment.')

def swap(o):
    if isinstance(o, dict):
        if o == {'literal': 100}: return {'field': 'policy_auto_approve_limit'}
        if o == {'literal': 1000}: return {'field': 'policy_manager_limit'}
        if o == {'literal': 200}: return {'field': 'policy_line_limit'}
        return {k: swap(v) for k, v in o.items()}
    if isinstance(o, list): return [swap(x) for x in o]
    return o
c['workflow']['transitions'] = swap(c['workflow']['transitions'])
for t in c['tests']:
    t['name'] = t['name'].replace('under the threshold', 'under the auto-approve limit')
    for s in t['steps']:
        if 'answers' in s:
            s['answers'].pop('manager_email', None)
            # the receipt rule is now a policy check, so every claim that is
            # meant to get through must carry one; only the missing-data case omits it
            if t['kind'] != 'missing_data':
                s['answers'].setdefault('receipt_reference', 'Scanned in the finance drive')
c['finance'] = {
    'kind': 'claim', 'amountField': 'expense_total', 'receiptField': 'receipt_reference',
    'categoryField': 'category', 'advanceReferenceField': 'advance_reference',
    'currencyField': 'claim_currency', 'baseAmountField': 'approval_amount_base', 'fxRateField': 'fx_rate',
    'costCentreField': 'cost_centre', 'linesField': 'line_items', 'lineAmountField': 'line_amount', 'lineDescriptionField': 'line_description',
    'policy': {'autoApproveLimit': 'policy_auto_approve_limit', 'managerLimit': 'policy_manager_limit', 'lineLimit': 'policy_line_limit'},
}
json.dump(c, open(f'{root}/processes/staff-expense-claim.blueprint.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)

# ------------------------------------------------------------- cash advance
roles = copy.deepcopy(src['roles'])
for r in roles:
    if r['key'] == 'finance_ops': r['editableFields'] = ['cost_centre']
    if r['key'] == 'claimant': r['editableFields'] = ['purpose']
cost_centre = next(f for f in src['data']['fields'] if f['key'] == 'cost_centre')
a = {
  'schemaVersion': '0.1', 'key': 'cash_advance', 'name': 'Cash advance',
  'description': ('PRD Module 5, EXP-06. Cash paid up front for a trip or a job. The manager from the directory approves, '
                  'Finance approves anything over the manager limit, and approval opens an advance record. Finance records '
                  'when it is paid out, which starts the clock for the holder to retire it with an expense claim.'),
  'intent': {'outcome': 'Approved cash is paid out up front and later accounted for with receipts or returned.', 'owner': 'finance_ops',
             'respondents': 'Any member of staff who needs money in advance.', 'expectedVolume': {'count': 40, 'per': 'month'},
             'sensitivityCeiling': 'confidential', 'completionState': 'approved', 'retentionDays': 2555},
  'roles': roles,
  'data': {
    'identity': ['employee_email', 'needed_by', 'cost_centre'],
    'submitterField': 'employee_email',
    'fields': [
      {'key': 'claimant_name', 'type': 'short_text', 'label': 'Your name', 'required': True, 'classification': 'confidential'},
      {'key': 'employee_email', 'type': 'email', 'label': 'Your work email', 'required': True, 'classification': 'internal'},
      {'key': 'needed_by', 'type': 'date', 'label': 'When you need it', 'required': True, 'classification': 'internal',
       'constraints': {'minDaysFromToday': 0, 'maxDaysFromToday': 180, 'message': 'Choose a date from today up to six months ahead.'}},
      cost_centre,
      {'key': 'purpose', 'type': 'long_text', 'label': 'What it is for', 'required': True, 'classification': 'internal',
       'constraints': {'minLength': 15, 'message': 'Say what the money is for and roughly how it breaks down.'}},
      {'key': 'advance_amount', 'type': 'currency', 'label': 'Amount needed', 'required': True, 'classification': 'confidential',
       'constraints': {'min': 1, 'message': 'Enter the amount you need.'}},
      {'key': 'policy_manager_limit', 'type': 'number', 'label': 'Manager limit at submission', 'classification': 'internal', 'setBy': 'system'},
    ],
  },
  'experience': {'showProgress': False, 'saveAndResume': True, 'locales': ['en'],
    'confirmation': {'message': 'Your request is with your manager. Once it is approved, Finance will pay it and give you the advance reference to quote when you claim your receipts.', 'showStatusLink': True},
    'pages': [{'key': 'request', 'title': 'Request an advance', 'sections': [
      {'key': 'who', 'fields': ['claimant_name', 'employee_email'], 'widths': {'claimant_name': 'half', 'employee_email': 'half'}},
      {'key': 'what', 'fields': ['advance_amount', 'needed_by', 'cost_centre', 'purpose'], 'widths': {'advance_amount': 'half', 'needed_by': 'half'}}]}]},
  'workflow': {
    'states': [
      {'key': 'draft', 'name': 'Not yet submitted', 'type': 'initial'},
      {'key': 'manager_review', 'name': 'With your manager', 'type': 'waiting', 'slaHours': 48, 'publicLabel': 'With your manager'},
      {'key': 'finance_review', 'name': 'With finance', 'type': 'waiting', 'slaHours': 48, 'publicLabel': 'With finance'},
      {'key': 'approved', 'name': 'Approved, awaiting payment', 'type': 'terminal', 'outcome': 'success', 'publicLabel': 'Approved'},
      {'key': 'rejected', 'name': 'Not approved', 'type': 'terminal', 'outcome': 'rejected', 'publicLabel': 'Not approved'},
      {'key': 'expired', 'name': 'Closed without a decision', 'type': 'terminal', 'outcome': 'expired', 'publicLabel': 'Closed'},
    ],
    'approvals': [
      {'key': 'manager_approval', 'name': 'Manager approval', 'approvers': [{'manager': 'submitter', 'fallback': 'line_manager'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True, 'contextFields': ['claimant_name', 'advance_amount', 'needed_by', 'purpose'], 'dueInHours': 48},
      {'key': 'finance_approval', 'name': 'Finance approval', 'approvers': [{'role': 'finance_approver'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True, 'contextFields': ['claimant_name', 'advance_amount', 'cost_centre', 'purpose'], 'dueInHours': 48},
    ],
    'tasks': [],
    'transitions': [
      {'key': 'submitted', 'from': 'draft', 'to': 'manager_review', 'trigger': {'on': 'submission'},
       'actions': [{'do': 'send_email', 'key': 'ack', 'template': 'request_received'}, {'do': 'request_approval', 'key': 'ask_manager', 'approval': 'manager_approval'}]},
      {'key': 'manager_approved_within_limit', 'from': 'manager_review', 'to': 'approved', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'approved'},
       'when': {'op': 'lte', 'left': {'field': 'advance_amount'}, 'right': {'field': 'policy_manager_limit'}},
       'actions': [{'do': 'send_email', 'key': 'ok', 'template': 'advance_approved'}]},
      {'key': 'manager_approved_over_limit', 'from': 'manager_review', 'to': 'finance_review', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'approved'},
       'when': {'op': 'gt', 'left': {'field': 'advance_amount'}, 'right': {'field': 'policy_manager_limit'}},
       'actions': [{'do': 'request_approval', 'key': 'ask_finance', 'approval': 'finance_approval'}]},
      {'key': 'manager_rejected', 'from': 'manager_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no', 'template': 'advance_rejected'}]},
      {'key': 'finance_approved', 'from': 'finance_review', 'to': 'approved', 'trigger': {'on': 'approval_decided', 'approval': 'finance_approval', 'decision': 'approved'},
       'actions': [{'do': 'send_email', 'key': 'ok_finance', 'template': 'advance_approved'}]},
      {'key': 'finance_rejected', 'from': 'finance_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'finance_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no_finance', 'template': 'advance_rejected'}]},
      {'key': 'finance_nudge', 'from': 'finance_review', 'to': 'finance_review', 'trigger': {'on': 'timer', 'afterHoursInState': 48},
       'actions': [{'do': 'send_email', 'key': 'nudge_finance', 'template': 'finance_reminder'}]},
      {'key': 'manager_never_decided', 'from': 'manager_review', 'to': 'expired', 'trigger': {'on': 'timer', 'afterHoursInState': 336},
       'actions': [{'do': 'send_email', 'key': 'closed', 'template': 'request_closed'}]},
    ],
  },
  'communications': {'fromName': 'Finance', 'sms': [], 'email': [
    {'key': 'request_received', 'name': 'Request received', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'We have your advance request', 'body': 'Hello {{claimant_name}},\n\nYour request for an advance, needed by {{needed_by}}, is with your manager. You will hear from us when it is decided.'},
    {'key': 'advance_approved', 'name': 'Advance approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your advance is approved', 'body': 'Hello {{claimant_name}},\n\nYour advance has been approved. Finance will pay it and give you its reference. Keep your receipts: you retire the advance by making an expense claim that quotes that reference.'},
    {'key': 'advance_rejected', 'name': 'Advance not approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your advance was not approved', 'body': 'Hello {{claimant_name}},\n\nYour advance request was not approved. The reason is on the record; open your request to read it.'},
    {'key': 'finance_reminder', 'name': 'Finance reminder', 'class': 'reminder', 'to': [{'role': 'finance_approver'}], 'cc': [],
     'subject': 'An advance request is waiting for finance', 'body': 'A request for an advance needed by {{needed_by}} has been waiting two days for a finance decision.'},
    {'key': 'request_closed', 'name': 'Request closed', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your advance request was closed', 'body': 'Hello {{claimant_name}},\n\nYour advance request had no decision for two weeks and has been closed. Send a new request if you still need the money.'},
  ]},
  'outputs': {'webhookEvents': [], 'exportFields': ['employee_email', 'needed_by', 'cost_centre'], 'documents': [],
    'dashboard': {'metrics': [{'key': 'requests', 'name': 'Advance requests', 'kind': 'intake'}, {'key': 'approved', 'name': 'Approved', 'kind': 'completion_rate'},
                              {'key': 'time', 'name': 'Days to decision', 'kind': 'cycle_time'}]}},
  'finance': {'kind': 'advance', 'amountField': 'advance_amount', 'policy': {'managerLimit': 'policy_manager_limit'}},
}
base = {'claimant_name': 'Sam Trent', 'employee_email': 'sam@example.com', 'needed_by': '2026-12-01', 'cost_centre': 'ops',
        'purpose': 'Site visit to Abuja: transport, lodging and meals for three days.'}
a['tests'] = [
  {'key': 'small_advance_manager_only', 'kind': 'happy_path', 'name': 'An advance within the manager limit needs only the manager',
   'steps': [{'step': 'submit', 'answers': {**base, 'advance_amount': 400}},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Trip agreed.'}],
   'expect': {'state': 'approved', 'emails': ['request_received', 'advance_approved'], 'instanceCount': 1}},
  {'key': 'large_advance_two_approvals', 'kind': 'happy_path', 'name': 'An advance over the manager limit also needs finance',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-02', 'advance_amount': 2500}},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Agreed.'},
             {'step': 'decide', 'approval': 'finance_approval', 'as': 'finance_approver', 'decision': 'approved', 'reason': 'Budget checked.'}],
   'expect': {'state': 'approved', 'emails': ['request_received', 'advance_approved'], 'instanceCount': 1}},
  {'key': 'advance_rejected', 'kind': 'rejection', 'name': 'A rejected advance opens no record',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-03', 'advance_amount': 300}},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'rejected', 'reason': 'Not needed.'}],
   'expect': {'state': 'rejected', 'emails': ['request_received', 'advance_rejected']}},
  {'key': 'no_amount', 'kind': 'missing_data', 'name': 'A request without an amount never reaches a manager',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-04'}}], 'expect': {'state': 'draft', 'instanceCount': 0}},
  {'key': 'self_approval', 'kind': 'permission', 'name': 'The requester cannot approve their own advance',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-05', 'advance_amount': 200}},
             {'step': 'attempt', 'as': 'claimant', 'action': 'approve', 'expectDenied': True},
             {'step': 'attempt', 'as': 'line_manager', 'action': 'approve', 'expectDenied': False}],
   'expect': {'state': 'manager_review'}},
  {'key': 'never_decided', 'kind': 'timeout', 'name': 'Two weeks without a manager decision closes the request',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-07', 'advance_amount': 250}}, {'step': 'advance_hours', 'hours': 336}],
   'expect': {'state': 'expired', 'emails': ['request_received', 'request_closed']}},
  {'key': 'duplicate', 'kind': 'duplicate', 'name': 'The same request sent twice opens one advance',
   'steps': [{'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-06', 'advance_amount': 150}},
             {'step': 'submit', 'answers': {**base, 'needed_by': '2026-12-06', 'advance_amount': 150}}],
   'expect': {'instanceCount': 1}},
]
json.dump(a, open(f'{root}/processes/cash-advance.blueprint.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('written')

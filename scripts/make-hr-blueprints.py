"""
Generates processes/hiring-request.blueprint.json (PRD Module 7, HR-01).

Run from the repo root:  python -I scripts/make-hr-blueprints.py .
Edit this script, not the generated file.
"""
import json, copy, sys
root = sys.argv[1]
claim = json.load(open(f'{root}/processes/staff-expense-claim.blueprint.json', encoding='utf-8'))
cost_centre = copy.deepcopy(next(f for f in claim['data']['fields'] if f['key'] == 'cost_centre'))

bp = {
  'schemaVersion': '0.1', 'key': 'hiring_request', 'name': 'Hiring request',
  'description': ("PRD Module 7, HR-01. A manager asks to hire. Their own manager from the directory approves the need, "
                  "then HR approves the position and budget. The cost centre's budget is held from submission. Approval "
                  "opens a hiring requisition; each hire against it starts an onboarding on the HR page. Candidate sourcing "
                  "stays in your applicant tracking system."),
  'intent': {'outcome': 'A position is approved with its justification, headcount and budget before anyone is hired.',
             'owner': 'hr_ops', 'respondents': 'Managers who need to hire.', 'expectedVolume': {'count': 10, 'per': 'month'},
             'sensitivityCeiling': 'confidential', 'completionState': 'approved', 'retentionDays': 2555},
  'roles': [
    {'key': 'hr_ops', 'name': 'HR', 'kind': 'internal', 'capabilities': ['view', 'edit', 'operate', 'report', 'administer'], 'editableFields': ['cost_centre']},
    {'key': 'line_manager', 'name': 'Line manager', 'kind': 'internal', 'capabilities': ['view', 'approve']},
    {'key': 'hr_approver', 'name': 'HR approver', 'kind': 'internal', 'capabilities': ['view', 'approve', 'report']},
    {'key': 'requester', 'name': 'Hiring manager', 'kind': 'respondent', 'capabilities': ['submit', 'view'], 'editableFields': ['justification']},
  ],
  'data': {
    'identity': ['employee_email', 'position', 'start_by'],
    'submitterField': 'employee_email',
    'fields': [
      {'key': 'requester_name', 'type': 'short_text', 'label': 'Your name', 'required': True, 'classification': 'internal'},
      {'key': 'employee_email', 'type': 'email', 'label': 'Your work email', 'required': True, 'classification': 'internal'},
      {'key': 'position', 'type': 'short_text', 'label': 'Position title', 'required': True, 'classification': 'internal',
       'constraints': {'minLength': 2, 'maxLength': 200, 'message': 'Give the job title.'}},
      {'key': 'headcount', 'type': 'number', 'label': 'How many people', 'required': True, 'classification': 'internal',
       'constraints': {'min': 1, 'max': 50, 'message': 'Between 1 and 50.'}},
      {'key': 'employment_type', 'type': 'dropdown', 'label': 'Type', 'required': True, 'classification': 'internal',
       'choices': [{'value': 'employee', 'label': 'Employee'}, {'value': 'contractor', 'label': 'Contractor'}, {'value': 'intern', 'label': 'Intern'}]},
      cost_centre,
      {'key': 'start_by', 'type': 'date', 'label': 'Needed from', 'required': True, 'classification': 'internal',
       'constraints': {'minDaysFromToday': 0, 'maxDaysFromToday': 365, 'message': 'Choose a date from today up to a year ahead.'}},
      {'key': 'justification', 'type': 'long_text', 'label': 'Why the position is needed', 'required': True, 'classification': 'internal',
       'constraints': {'minLength': 30, 'message': 'Say what the person will do and why now.'}},
      {'key': 'annual_cost', 'type': 'currency', 'label': 'Estimated yearly cost of all hires', 'required': True, 'classification': 'confidential',
       'constraints': {'min': 1, 'message': 'Give your best estimate, including pay and on-costs.'}},
      {'key': 'policy_manager_limit', 'type': 'number', 'label': 'Manager limit at submission', 'classification': 'internal', 'setBy': 'system'},
    ],
  },
  'experience': {'showProgress': False, 'saveAndResume': True, 'locales': ['en'],
    'confirmation': {'message': 'Your request is with your manager, then HR. You can follow it from your status link.', 'showStatusLink': True},
    'pages': [{'key': 'request', 'title': 'Hiring request', 'sections': [
      {'key': 'who', 'fields': ['requester_name', 'employee_email'], 'widths': {'requester_name': 'half', 'employee_email': 'half'}},
      {'key': 'what', 'fields': ['position', 'headcount', 'employment_type', 'cost_centre', 'start_by', 'annual_cost', 'justification'],
       'widths': {'headcount': 'half', 'employment_type': 'half', 'cost_centre': 'half', 'start_by': 'half'}}]}]},
  'workflow': {
    'states': [
      {'key': 'draft', 'name': 'Not yet submitted', 'type': 'initial'},
      {'key': 'manager_review', 'name': 'With your manager', 'type': 'waiting', 'slaHours': 72, 'publicLabel': 'With your manager'},
      {'key': 'hr_review', 'name': 'With HR', 'type': 'waiting', 'slaHours': 72, 'publicLabel': 'With HR'},
      {'key': 'approved', 'name': 'Approved to hire', 'type': 'terminal', 'outcome': 'success', 'publicLabel': 'Approved'},
      {'key': 'rejected', 'name': 'Not approved', 'type': 'terminal', 'outcome': 'rejected', 'publicLabel': 'Not approved'},
      {'key': 'expired', 'name': 'Closed without a decision', 'type': 'terminal', 'outcome': 'expired', 'publicLabel': 'Closed'},
    ],
    'approvals': [
      {'key': 'manager_approval', 'name': 'Manager approval', 'approvers': [{'manager': 'submitter', 'fallback': 'line_manager'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True,
       'contextFields': ['requester_name', 'position', 'headcount', 'justification'], 'dueInHours': 72},
      {'key': 'hr_approval', 'name': 'HR approval', 'approvers': [{'role': 'hr_approver'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True,
       'contextFields': ['position', 'headcount', 'employment_type', 'cost_centre', 'annual_cost', 'justification'], 'dueInHours': 72},
    ],
    'tasks': [],
    'transitions': [
      {'key': 'submitted', 'from': 'draft', 'to': 'manager_review', 'trigger': {'on': 'submission'},
       'actions': [{'do': 'send_email', 'key': 'ack', 'template': 'request_received'}, {'do': 'request_approval', 'key': 'ask_manager', 'approval': 'manager_approval'}]},
      {'key': 'manager_approved', 'from': 'manager_review', 'to': 'hr_review', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'approved'},
       'actions': [{'do': 'request_approval', 'key': 'ask_hr', 'approval': 'hr_approval'}]},
      {'key': 'manager_rejected', 'from': 'manager_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no', 'template': 'request_rejected'}]},
      {'key': 'hr_approved', 'from': 'hr_review', 'to': 'approved', 'trigger': {'on': 'approval_decided', 'approval': 'hr_approval', 'decision': 'approved'},
       'actions': [{'do': 'send_email', 'key': 'ok', 'template': 'request_approved'}]},
      {'key': 'hr_rejected', 'from': 'hr_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'hr_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no_hr', 'template': 'request_rejected'}]},
      {'key': 'hr_nudge', 'from': 'hr_review', 'to': 'hr_review', 'trigger': {'on': 'timer', 'afterHoursInState': 72},
       'actions': [{'do': 'send_email', 'key': 'nudge_hr', 'template': 'hr_reminder'}]},
      {'key': 'manager_never_decided', 'from': 'manager_review', 'to': 'expired', 'trigger': {'on': 'timer', 'afterHoursInState': 336},
       'actions': [{'do': 'send_email', 'key': 'closed', 'template': 'request_closed'}]},
    ],
  },
  'communications': {'fromName': 'HR', 'sms': [], 'email': [
    {'key': 'request_received', 'name': 'Request received', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'We have your hiring request', 'body': 'Hello {{requester_name}},\n\nYour request to hire {{headcount}} {{position}} is with your manager, then HR.'},
    {'key': 'request_approved', 'name': 'Request approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your hiring request is approved', 'body': 'Hello {{requester_name}},\n\nYou can hire {{headcount}} {{position}}. HR will start each onboarding as people accept.'},
    {'key': 'request_rejected', 'name': 'Request not approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your hiring request was not approved', 'body': 'Hello {{requester_name}},\n\nYour request to hire {{position}} was not approved. The reason is on the record.'},
    {'key': 'hr_reminder', 'name': 'HR reminder', 'class': 'reminder', 'to': [{'role': 'hr_approver'}], 'cc': [],
     'subject': 'A hiring request is waiting for HR', 'body': 'A request to hire {{position}} has been waiting three days for HR.'},
    {'key': 'request_closed', 'name': 'Request closed', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your hiring request was closed', 'body': 'Hello {{requester_name}},\n\nYour request to hire {{position}} had no decision for two weeks and has been closed.'},
  ]},
  'outputs': {'webhookEvents': [], 'exportFields': ['position', 'headcount', 'cost_centre', 'start_by'], 'documents': [],
    'dashboard': {'metrics': [{'key': 'requests', 'name': 'Hiring requests', 'kind': 'intake'}, {'key': 'approved', 'name': 'Approved', 'kind': 'completion_rate'},
                              {'key': 'time', 'name': 'Days to decision', 'kind': 'cycle_time'}]}},
  'finance': {'kind': 'hiring', 'amountField': 'annual_cost', 'costCentreField': 'cost_centre', 'titleField': 'position',
              'neededByField': 'start_by', 'headcountField': 'headcount', 'policy': {'managerLimit': 'policy_manager_limit'}},
}
base = {'requester_name': 'Mo Manager', 'employee_email': 'mo@example.com', 'employment_type': 'employee', 'cost_centre': 'ops',
        'justification': 'Two new field officers to cover the Abuja route from January, replacing contractor cover.', 'annual_cost': 9000}
def ask(position, day, n=1): return {**base, 'position': position, 'headcount': n, 'start_by': f'2026-12-{day:02d}'}
bp['tests'] = [
  {'key': 'approved_by_both', 'kind': 'happy_path', 'name': 'A request approved by the manager and HR',
   'steps': [{'step': 'submit', 'answers': ask('Field officer', 1, 2)},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Needed.'},
             {'step': 'decide', 'approval': 'hr_approval', 'as': 'hr_approver', 'decision': 'approved', 'reason': 'Budgeted.'}],
   'expect': {'state': 'approved', 'emails': ['request_received', 'request_approved'], 'instanceCount': 1}},
  {'key': 'hr_says_no', 'kind': 'rejection', 'name': 'HR can reject after the manager approves',
   'steps': [{'step': 'submit', 'answers': ask('Analyst', 2)},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Ok.'},
             {'step': 'decide', 'approval': 'hr_approval', 'as': 'hr_approver', 'decision': 'rejected', 'reason': 'Freeze.'}],
   'expect': {'state': 'rejected', 'emails': ['request_received', 'request_rejected']}},
  {'key': 'no_cost', 'kind': 'missing_data', 'name': 'A request without a cost never reaches a manager',
   'steps': [{'step': 'submit', 'answers': {k: v for k, v in ask('Driver', 3).items() if k != 'annual_cost'}}], 'expect': {'state': 'draft', 'instanceCount': 0}},
  {'key': 'self_approval', 'kind': 'permission', 'name': 'The requester cannot approve their own request',
   'steps': [{'step': 'submit', 'answers': ask('Cleaner', 4)},
             {'step': 'attempt', 'as': 'requester', 'action': 'approve', 'expectDenied': True},
             {'step': 'attempt', 'as': 'line_manager', 'action': 'approve', 'expectDenied': False}],
   'expect': {'state': 'manager_review'}},
  {'key': 'never_decided', 'kind': 'timeout', 'name': 'Two weeks without a manager decision closes the request',
   'steps': [{'step': 'submit', 'answers': ask('Receptionist', 5)}, {'step': 'advance_hours', 'hours': 336}],
   'expect': {'state': 'expired', 'emails': ['request_received', 'request_closed']}},
  {'key': 'duplicate', 'kind': 'duplicate', 'name': 'The same request sent twice is one request',
   'steps': [{'step': 'submit', 'answers': ask('Guard', 6)}, {'step': 'submit', 'answers': ask('Guard', 6)}], 'expect': {'instanceCount': 1}},
  {'key': 'approved_single', 'kind': 'happy_path', 'name': 'A single hire follows the same route',
   'steps': [{'step': 'submit', 'answers': ask('Accountant', 7)},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Needed.'},
             {'step': 'decide', 'approval': 'hr_approval', 'as': 'hr_approver', 'decision': 'approved', 'reason': 'Ok.'}],
   'expect': {'state': 'approved', 'instanceCount': 1}},
]
json.dump(bp, open(f'{root}/processes/hiring-request.blueprint.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('written')

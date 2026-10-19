"""
Generates processes/purchase-request.blueprint.json (PRD Module 6, PRC-03).

Run from the repo root:  python -I scripts/make-procurement-blueprints.py .
Edit this script, not the generated file.
"""
import json, copy, sys
root = sys.argv[1]
claim = json.load(open(f'{root}/processes/staff-expense-claim.blueprint.json', encoding='utf-8'))
cost_centre = copy.deepcopy(next(f for f in claim['data']['fields'] if f['key'] == 'cost_centre'))

roles = [
  {'key': 'procurement_ops', 'name': 'Procurement', 'kind': 'internal', 'capabilities': ['view', 'edit', 'operate', 'report', 'administer'], 'editableFields': ['cost_centre', 'delivery_location']},
  {'key': 'line_manager', 'name': 'Line manager', 'kind': 'internal', 'capabilities': ['view', 'approve']},
  {'key': 'procurement_approver', 'name': 'Procurement approver', 'kind': 'internal', 'capabilities': ['view', 'approve', 'report']},
  {'key': 'requester', 'name': 'Requester', 'kind': 'respondent', 'capabilities': ['submit', 'view'], 'editableFields': ['purpose']},
]

bp = {
  'schemaVersion': '0.1', 'key': 'purchase_request', 'name': 'Purchase request',
  'description': ('PRD Module 6. Staff ask to buy something. The manager from the directory approves; anything over '
                  "Procurement's manager limit also needs a procurement approver. The cost centre's budget is held from "
                  'submission. Approval opens a requisition that Procurement sources, orders, receives and pays on the '
                  'Procurement page; the requester follows progress on this record but never sees competing quotes.'),
  'intent': {'outcome': 'What staff need is approved, bought from an approved supplier, delivered and paid for against the order.',
             'owner': 'procurement_ops', 'respondents': 'Any member of staff who needs to buy something.',
             'expectedVolume': {'count': 60, 'per': 'month'}, 'sensitivityCeiling': 'confidential', 'completionState': 'approved', 'retentionDays': 2555},
  'roles': roles,
  'data': {
    'identity': ['employee_email', 'title', 'needed_by'],
    'submitterField': 'employee_email',
    'fields': [
      {'key': 'requester_name', 'type': 'short_text', 'label': 'Your name', 'required': True, 'classification': 'internal'},
      {'key': 'employee_email', 'type': 'email', 'label': 'Your work email', 'required': True, 'classification': 'internal'},
      {'key': 'title', 'type': 'short_text', 'label': 'What do you need?', 'required': True, 'classification': 'internal',
       'constraints': {'minLength': 3, 'maxLength': 200, 'message': 'A short name for the request, such as "Laptops for new field staff".'}},
      cost_centre,
      {'key': 'needed_by', 'type': 'date', 'label': 'Needed by', 'required': True, 'classification': 'internal',
       'constraints': {'minDaysFromToday': 0, 'maxDaysFromToday': 365, 'message': 'Choose a date from today up to a year ahead.'}},
      {'key': 'delivery_location', 'type': 'short_text', 'label': 'Deliver to', 'required': True, 'classification': 'internal'},
      {'key': 'purpose', 'type': 'long_text', 'label': 'Why it is needed', 'required': True, 'classification': 'internal',
       'constraints': {'minLength': 15, 'message': 'Say what it is for, so your manager can decide.'}},
      {'key': 'suggested_supplier', 'type': 'short_text', 'label': 'Supplier you suggest (optional)', 'classification': 'internal',
       'help': 'Procurement decides who to buy from; a suggestion helps.'},
      {'key': 'line_items', 'type': 'repeating_group', 'label': 'Items', 'required': True, 'classification': 'internal',
       'fields': [
         {'key': 'item_description', 'type': 'short_text', 'label': 'Item and specification', 'required': True, 'classification': 'internal'},
         {'key': 'quantity', 'type': 'number', 'label': 'Quantity', 'required': True, 'classification': 'internal', 'constraints': {'min': 1, 'message': 'At least one.'}},
         {'key': 'estimated_cost', 'type': 'currency', 'label': 'Estimated cost for this line', 'required': True, 'classification': 'internal',
          'constraints': {'min': 0.01, 'message': 'Give your best estimate.'}},
       ]},
      {'key': 'request_total', 'type': 'calculated', 'label': 'Estimated total', 'classification': 'internal',
       'compute': {'op': 'sum', 'over': 'line_items', 'of': 'estimated_cost'}},
      {'key': 'policy_manager_limit', 'type': 'number', 'label': 'Manager limit at submission', 'classification': 'internal', 'setBy': 'system'},
    ],
  },
  'experience': {'showProgress': True, 'saveAndResume': True, 'locales': ['en'],
    'confirmation': {'message': 'Your request is with your manager. Once approved, Procurement buys it and you can follow progress from your status link.', 'showStatusLink': True},
    'pages': [
      {'key': 'need', 'title': 'What you need', 'sections': [
        {'key': 'who', 'fields': ['requester_name', 'employee_email'], 'widths': {'requester_name': 'half', 'employee_email': 'half'}},
        {'key': 'what', 'fields': ['title', 'cost_centre', 'needed_by', 'delivery_location', 'purpose', 'suggested_supplier'],
         'widths': {'cost_centre': 'half', 'needed_by': 'half'}}]},
      {'key': 'items', 'title': 'Items', 'description': 'One line per item. The total is worked out for you.', 'sections': [
        {'key': 'lines', 'fields': ['line_items']}]},
    ]},
  'workflow': {
    'states': [
      {'key': 'draft', 'name': 'Not yet submitted', 'type': 'initial'},
      {'key': 'manager_review', 'name': 'With your manager', 'type': 'waiting', 'slaHours': 48, 'publicLabel': 'With your manager'},
      {'key': 'procurement_review', 'name': 'With procurement', 'type': 'waiting', 'slaHours': 48, 'publicLabel': 'With procurement'},
      {'key': 'approved', 'name': 'Approved, being bought', 'type': 'terminal', 'outcome': 'success', 'publicLabel': 'Approved'},
      {'key': 'rejected', 'name': 'Not approved', 'type': 'terminal', 'outcome': 'rejected', 'publicLabel': 'Not approved'},
      {'key': 'expired', 'name': 'Closed without a decision', 'type': 'terminal', 'outcome': 'expired', 'publicLabel': 'Closed'},
    ],
    'approvals': [
      {'key': 'manager_approval', 'name': 'Manager approval', 'approvers': [{'manager': 'submitter', 'fallback': 'line_manager'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True,
       'contextFields': ['requester_name', 'title', 'request_total', 'needed_by', 'purpose'], 'dueInHours': 48},
      {'key': 'procurement_approval', 'name': 'Procurement approval', 'approvers': [{'role': 'procurement_approver'}], 'mode': 'single',
       'allowRequestChanges': False, 'reasonRequired': True, 'notTheSubmitter': True,
       'contextFields': ['requester_name', 'title', 'request_total', 'cost_centre', 'line_items'], 'dueInHours': 48},
    ],
    'tasks': [],
    'transitions': [
      {'key': 'submitted', 'from': 'draft', 'to': 'manager_review', 'trigger': {'on': 'submission'},
       'actions': [{'do': 'send_email', 'key': 'ack', 'template': 'request_received'}, {'do': 'request_approval', 'key': 'ask_manager', 'approval': 'manager_approval'}]},
      {'key': 'manager_approved_within_limit', 'from': 'manager_review', 'to': 'approved', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'approved'},
       'when': {'op': 'lte', 'left': {'field': 'request_total'}, 'right': {'field': 'policy_manager_limit'}},
       'actions': [{'do': 'send_email', 'key': 'ok', 'template': 'request_approved'}]},
      {'key': 'manager_approved_over_limit', 'from': 'manager_review', 'to': 'procurement_review', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'approved'},
       'when': {'op': 'gt', 'left': {'field': 'request_total'}, 'right': {'field': 'policy_manager_limit'}},
       'actions': [{'do': 'request_approval', 'key': 'ask_procurement', 'approval': 'procurement_approval'}]},
      {'key': 'manager_rejected', 'from': 'manager_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'manager_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no', 'template': 'request_rejected'}]},
      {'key': 'procurement_approved', 'from': 'procurement_review', 'to': 'approved', 'trigger': {'on': 'approval_decided', 'approval': 'procurement_approval', 'decision': 'approved'},
       'actions': [{'do': 'send_email', 'key': 'ok_procurement', 'template': 'request_approved'}]},
      {'key': 'procurement_rejected', 'from': 'procurement_review', 'to': 'rejected', 'trigger': {'on': 'approval_decided', 'approval': 'procurement_approval', 'decision': 'rejected'},
       'actions': [{'do': 'send_email', 'key': 'no_procurement', 'template': 'request_rejected'}]},
      {'key': 'procurement_nudge', 'from': 'procurement_review', 'to': 'procurement_review', 'trigger': {'on': 'timer', 'afterHoursInState': 48},
       'actions': [{'do': 'send_email', 'key': 'nudge_procurement', 'template': 'procurement_reminder'}]},
      {'key': 'manager_never_decided', 'from': 'manager_review', 'to': 'expired', 'trigger': {'on': 'timer', 'afterHoursInState': 336},
       'actions': [{'do': 'send_email', 'key': 'closed', 'template': 'request_closed'}]},
    ],
  },
  'communications': {'fromName': 'Procurement', 'sms': [], 'email': [
    {'key': 'request_received', 'name': 'Request received', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'We have your purchase request', 'body': 'Hello {{requester_name}},\n\nYour request "{{title}}", needed by {{needed_by}}, is with your manager.'},
    {'key': 'request_approved', 'name': 'Request approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your purchase request is approved', 'body': 'Hello {{requester_name}},\n\nYour request "{{title}}" is approved. Procurement will order it; you can follow progress from your status link.'},
    {'key': 'request_rejected', 'name': 'Request not approved', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your purchase request was not approved', 'body': 'Hello {{requester_name}},\n\nYour request "{{title}}" was not approved. The reason is on the record.'},
    {'key': 'procurement_reminder', 'name': 'Procurement reminder', 'class': 'reminder', 'to': [{'role': 'procurement_approver'}], 'cc': [],
     'subject': 'A purchase request is waiting for procurement', 'body': 'A purchase request needed by {{needed_by}} has been waiting two days for a procurement decision.'},
    {'key': 'request_closed', 'name': 'Request closed', 'class': 'transactional', 'to': [{'submitter': True}], 'cc': [],
     'subject': 'Your purchase request was closed', 'body': 'Hello {{requester_name}},\n\nYour request "{{title}}" had no decision for two weeks and has been closed. Send it again if you still need it.'},
  ]},
  'outputs': {'webhookEvents': [], 'exportFields': ['employee_email', 'title', 'cost_centre', 'needed_by'], 'documents': [],
    'dashboard': {'metrics': [{'key': 'requests', 'name': 'Purchase requests', 'kind': 'intake'}, {'key': 'approved', 'name': 'Approved', 'kind': 'completion_rate'},
                              {'key': 'time', 'name': 'Days to decision', 'kind': 'cycle_time'}]}},
  'finance': {'kind': 'purchase', 'amountField': 'request_total', 'costCentreField': 'cost_centre', 'titleField': 'title', 'neededByField': 'needed_by',
              'linesField': 'line_items', 'lineAmountField': 'estimated_cost', 'lineDescriptionField': 'item_description',
              'policy': {'managerLimit': 'policy_manager_limit'}},
}
base = {'requester_name': 'Sam Trent', 'employee_email': 'sam@example.com', 'cost_centre': 'ops',
        'delivery_location': 'Lagos office, 3rd floor', 'purpose': 'Two laptops for the new field officers starting next month.'}
def ask(title, day, lines): return {**base, 'title': title, 'needed_by': f'2026-12-{day:02d}', 'line_items': [{'item_description': d, 'quantity': q, 'estimated_cost': c} for d, q, c in lines]}
bp['tests'] = [
  {'key': 'small_request_manager_only', 'kind': 'happy_path', 'name': 'A request within the manager limit needs only the manager',
   'steps': [{'step': 'submit', 'answers': ask('Printer toner', 1, [('Toner cartridge', 2, 300)])},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Needed.'}],
   'expect': {'state': 'approved', 'emails': ['request_received', 'request_approved'], 'instanceCount': 1}},
  {'key': 'large_request_two_approvals', 'kind': 'happy_path', 'name': 'A request over the manager limit also needs procurement',
   'steps': [{'step': 'submit', 'answers': ask('Laptops', 2, [('Laptop, 16GB', 2, 1400)])},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'approved', 'reason': 'Agreed.'},
             {'step': 'decide', 'approval': 'procurement_approval', 'as': 'procurement_approver', 'decision': 'approved', 'reason': 'Budget checked.'}],
   'expect': {'state': 'approved', 'emails': ['request_received', 'request_approved'], 'instanceCount': 1}},
  {'key': 'request_rejected', 'kind': 'rejection', 'name': 'A rejected request opens no requisition',
   'steps': [{'step': 'submit', 'answers': ask('Desk chairs', 3, [('Chair', 4, 150)])},
             {'step': 'decide', 'approval': 'manager_approval', 'as': 'line_manager', 'decision': 'rejected', 'reason': 'Not this quarter.'}],
   'expect': {'state': 'rejected', 'emails': ['request_received', 'request_rejected']}},
  {'key': 'no_items', 'kind': 'missing_data', 'name': 'A request without items never reaches a manager',
   'steps': [{'step': 'submit', 'answers': {**base, 'title': 'Nothing', 'needed_by': '2026-12-04'}}], 'expect': {'state': 'draft', 'instanceCount': 0}},
  {'key': 'self_approval', 'kind': 'permission', 'name': 'The requester cannot approve their own request',
   'steps': [{'step': 'submit', 'answers': ask('Projector', 5, [('Projector', 1, 600)])},
             {'step': 'attempt', 'as': 'requester', 'action': 'approve', 'expectDenied': True},
             {'step': 'attempt', 'as': 'line_manager', 'action': 'approve', 'expectDenied': False}],
   'expect': {'state': 'manager_review'}},
  {'key': 'never_decided', 'kind': 'timeout', 'name': 'Two weeks without a manager decision closes the request',
   'steps': [{'step': 'submit', 'answers': ask('Whiteboard', 6, [('Whiteboard', 1, 90)])}, {'step': 'advance_hours', 'hours': 336}],
   'expect': {'state': 'expired', 'emails': ['request_received', 'request_closed']}},
  {'key': 'duplicate', 'kind': 'duplicate', 'name': 'The same request sent twice is one request',
   'steps': [{'step': 'submit', 'answers': ask('Cables', 7, [('HDMI cable', 5, 10)])}, {'step': 'submit', 'answers': ask('Cables', 7, [('HDMI cable', 5, 10)])}],
   'expect': {'instanceCount': 1}},
]
json.dump(bp, open(f'{root}/processes/purchase-request.blueprint.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('written')

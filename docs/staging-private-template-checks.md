# Private template staging checks — 23 September 2026

Workspace: LogaXP on `https://patforms.com`. All submissions below used fictional names, reserved `.test` email addresses and test-only text. The published processes are labelled `TEST`.

| Template | Process key | Test record | Browser result |
| --- | --- | --- | --- |
| Safeguarding concern | `test_safeguarding_concern` | `1B3ED85B` | Form submitted; safeguarding lead approved; case-reference task completed; record reached Finished. |
| Dispute or claim intake | `test_legal_dispute` | `D2E82A45` | Form submitted; Legal reviewer approved; matter-reference task completed; work queue returned to zero. |
| Test result enquiry | `test_healthcare_result_v2` | `7EA5E000` | Corrected form submitted; clinician approved; contact-reference task completed; respondent status showed Complete. |

Each template's eight sample records passed in staging before publication. The work queues showed only the test reference, submitter and action; the restricted concern, allegation and clinical enquiry text appeared in the record view for the assigned reviewer. A second account with a different role is still needed to verify the restricted fields are hidden in that role's record view and exports through the staging screens. The automated redaction test covers this rule in code.

The `.test` email acknowledgements were deliberately rejected as undeliverable. This is expected for reserved synthetic addresses and is not evidence of a live email delivery failure. Do not replay those actions.

Two defects found during these checks were fixed and deployed: the Healthcare pack now requires a safe callback number and tells staff to verify identity before discussing results; operator tasks now show their instructions beside the required completion field. A separate console fix makes a record opened by direct link select its own process and display the correct process name.

The first Healthcare draft, `c22bfa47-2e46-4578-9130-421038e55503`, predates the callback-field correction and was not published. The replacement draft was published as `test_healthcare_result_v2`.

These checks prove the application path with synthetic data. They do not establish that a real safeguarding action, clinical contact or legal matter was performed, or that the templates satisfy a particular organisation's policies or legal duties.

export const marketingModules = {
  core: {
    name: 'Forms & workflow',
    eyebrow: 'The foundation',
    headline: 'Turn a request into a process people can follow.',
    intro: 'Build the form, decisions, tasks and record together. The same process carries work from submission to a clear outcome.',
    example: 'A hiring request reaches Finance, IT and HR in order. Each team sees its own task and the same record keeps the history.',
    capabilities: [
      ['Build together', 'Describe the work once, then review the form and its workflow before publishing.'],
      ['Guide the next step', 'Route work by status, trigger and condition instead of relying on someone to forward it.'],
      ['Keep the record', 'Answers, decisions and actions remain attached to the process version that handled them.'],
    ],
    flow: ['Collect a request', 'Route the decision', 'Keep the outcome'],
    cta: 'Build a process',
  },
  expenses: {
    name: 'Expenses', eyebrow: 'Spending with context',
    headline: 'See the request before the money moves.',
    intro: 'Bring claims, advances and budget decisions into one accountable flow, with the reason and approval beside each amount.',
    example: 'A team asks for a laptop advance. The budget is checked and held at approval, then the claim is settled against that decision.',
    capabilities: [
      ['Claims and advances', 'Capture what the money is for and the evidence that supports it.'],
      ['Budget at approval', 'Keep a budget decision with the request that caused it.'],
      ['Traceable settlement', 'Follow the request through approval and reconciliation.'],
    ],
    flow: ['Submit a claim', 'Review the budget', 'Settle and record'], cta: 'Explore expenses',
  },
  procurement: {
    name: 'Procurement', eyebrow: 'Purchasing, connected',
    headline: 'Carry the purchase from quote to receipt.',
    intro: 'Connect supplier selection, purchase orders, goods received and invoices so each handoff has its supporting record.',
    example: 'Three suppliers submit sealed quotes. After the deadline, the team compares them, issues an order and matches the invoice to what arrived.',
    capabilities: [
      ['Sealed quotes', 'Keep bids closed until the agreed opening time.'],
      ['Orders and receipts', 'Show what was ordered and what the team actually received.'],
      ['Three-way matching', 'Compare order, receipt and invoice before payment review.'],
    ],
    flow: ['Compare quotes', 'Place an order', 'Match the invoice'], cta: 'Explore procurement',
  },
  hr: {
    name: 'HR', eyebrow: 'People operations',
    headline: 'Make day one feel prepared.',
    intro: 'Coordinate the decisions and tasks around joining, changing roles and leaving, without losing the person behind the process.',
    example: 'A new colleague is approved to join. HR, IT and the manager receive their tasks; access is recorded when the connected system confirms it.',
    capabilities: [
      ['Joined-up onboarding', 'Give every team its part of the arrival.'],
      ['Access confirmation', 'Track the difference between a request and confirmed access.'],
      ['A lasting trail', 'Keep role changes and offboarding decisions in order.'],
    ],
    flow: ['Approve a hire', 'Prepare access', 'Confirm day one'], cta: 'Explore HR',
  },
  appraisals: {
    name: 'Goals & appraisals', eyebrow: 'Performance conversations',
    headline: 'Give reviews a clearer, fairer shape.',
    intro: 'Run goal cycles, gather feedback and record calibration decisions with the context needed for a good conversation.',
    example: 'A manager sets goals, peers contribute feedback and a review panel records its decision. A rating does not change pay on its own.',
    capabilities: [
      ['Goals in context', 'Keep objectives and progress visible through the cycle.'],
      ['Structured feedback', 'Gather input without scattering it across inboxes.'],
      ['Recorded calibration', 'Show how a review outcome was reached.'],
    ],
    flow: ['Set goals', 'Gather feedback', 'Review together'], cta: 'Explore appraisals',
  },
  ops: {
    name: 'Assets & IT', eyebrow: 'Operational support',
    headline: 'Know what was issued, changed and returned.',
    intro: 'Put assets, access, service requests and changes beside the work and people they support.',
    example: 'A laptop is received, tagged and assigned to a new colleague. Its custody and later service work remain visible.',
    capabilities: [
      ['Asset custody', 'Record when equipment enters, moves and leaves the register.'],
      ['Service work', 'Track tickets and maintenance through a clear owner and status.'],
      ['Controlled changes', 'Keep access and change requests tied to the decision behind them.'],
    ],
    flow: ['Receive an asset', 'Assign an owner', 'Track its history'], cta: 'Explore assets & IT',
  },
  gov: {
    name: 'Contracts & compliance', eyebrow: 'Governance in the flow',
    headline: 'Keep obligations close to the work.',
    intro: 'Review agreements, track renewal dates and preserve the evidence behind policy and audit decisions.',
    example: 'A contract moves through review and signature. Months later, an auditor sees only the records in scope, for the period allowed.',
    capabilities: [
      ['Contract lifecycle', 'See review, signing, renewal and notice dates in one place.'],
      ['Scoped review', 'Give an auditor read-only access to the records relevant to an engagement.'],
      ['Retention and holds', 'Keep a legal hold from being silently bypassed by routine deletion.'],
    ],
    flow: ['Review terms', 'Track obligations', 'Show the evidence'], cta: 'Explore compliance',
  },
  sign: {
    name: 'Patform Sign', eyebrow: 'Signatures on the record',
    headline: 'Sign it here. Prove it anywhere.',
    intro: 'Send documents for electronic signature from the record they belong to, then keep the signed copy and evidence together.',
    example: 'Two directors sign an agreement. The completed PDF returns to the contract record with its certificate seal and verification details.',
    capabilities: [
      ['Flexible signing order', 'Invite signers in sequence or together, including company signing rules.'],
      ['Identity and consent', 'Record the code check and the signer’s expressed consent.'],
      ['Verifiable copy', 'Seal the signed PDF and make its integrity checkable later.'],
    ],
    flow: ['Place signature fields', 'Invite signers', 'Verify the copy'], cta: 'Explore Patform Sign',
  },
  meetings: {
    name: 'Meetings & resolutions', eyebrow: 'Board, management and committees',
    headline: 'Turn a meeting into a decision you can prove.',
    intro: 'Plan meetings, check quorum, record minutes and actions, then circulate resolutions for voting and signature. This module is in development.',
    example: 'A board chair calls a meeting with an agenda and papers. Members confirm attendance, vote on a resolution, and directors sign the approved text through Patform Sign.',
    capabilities: [
      ['Meetings with a clear record', 'Set membership, chair and quorum; send notices and papers; record attendance and minutes against each agenda item.'],
      ['Decisions and signatures', 'Record votes and written resolutions, then route the agreed text for director signatures through Patform Sign.'],
      ['Actions and audit history', 'Assign follow-up work, keep minutes and resolutions in an append-only register, and preserve records under legal hold.'],
    ],
    flow: ['Call the meeting', 'Record decisions', 'Sign and track actions'], cta: 'Explore meetings',
  },
} as const;

export type MarketingModuleKey = keyof typeof marketingModules;

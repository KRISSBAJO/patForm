'use client';

/**
 * A card that shows the process rather than describing it.
 *
 * The version before this was a title, a sentence and two buttons — which
 * makes somebody read nine cards to compare two. A template gallery works
 * because every card is a picture of the thing you would get, so this draws
 * the two things a process actually is: **the path a record takes** and
 * **what the form asks for**.
 *
 * Both are read from the blueprint at publish time. A preview cannot depict a
 * process the pack does not contain, which is the same rule the counts follow
 * — a card is a description, not marketing.
 */

export interface PackPreview {
  flow: { name: string; kind: string }[];
  askedFor: string[];
  deciders: string[];
}

export interface PackContents {
  fields: number;
  states: number;
  approvals: number;
  tasks: number;
  emails: number;
  documents: number;
  metrics: number;
  scenarios: number;
  roles: { key: string; name: string; kind: string }[];
  /** Absent on packs published before previews existed. */
  preview?: PackPreview;
  policy: {
    sensitivityCeiling: string;
    retentionDays: number | null;
    restrictedFields: number;
    fieldsHiddenFromSomeone: number;
  };
}

export interface Pack {
  id: string;
  packKey: string;
  version: number;
  name: string;
  summary: string;
  category: string;
  audience: string;
  contents: PackContents;
  builtIn: boolean;
}

/**
 * The miniature.
 *
 * Form lines on the left, the path on the right — the two halves of what a
 * pack is. Drawn small enough to be a texture at a glance and legible if you
 * look, which is what makes a gallery scannable.
 *
 * `aria-hidden`, because everything in it is said in words underneath. A
 * screen reader reading eighty-eight miniature flow diagrams is worse than
 * one that reads none.
 */
export function PackThumb({ pack }: { pack: Pack }) {
  /*
   * A pack published before the preview existed has no preview.
   *
   * Contents are computed once, at publish time, and stored — which is what
   * stops a card drifting from what installing gives you, and also means a
   * pack from last month carries last month's shape. A tenant's own packs are
   * not republished by an upgrade, so this has to survive the absence rather
   * than assume everything has been re-seeded.
   */
  const preview = pack.contents.preview ?? { flow: [], askedFor: [], deciders: [] };
  const flow = preview.flow.slice(0, 4);

  return (
    <div className="pk__thumb" aria-hidden="true">
      <div className="pk__thumbForm">
        <span className="pk__thumbBar pk__thumbBar--title" />
        {preview.askedFor.slice(0, 4).map((label, i) => (
          <span key={i} className="pk__thumbField">
            <span className="pk__thumbLabel">{label}</span>
            <span className="pk__thumbInput" />
          </span>
        ))}
        <span className="pk__thumbSubmit" />
      </div>

      <div className="pk__thumbFlow">
        {flow.map((s, i) => (
          <span key={i} className={`pk__node pk__node--${s.kind}`}>
            <span className="pk__nodeDot" />
            <span className="pk__nodeName">{s.name}</span>
          </span>
        ))}
        {preview.flow.length > flow.length && (
          <span className="pk__node pk__node--more">
            <span className="pk__nodeDot" />
            <span className="pk__nodeName">+{preview.flow.length - flow.length} more</span>
          </span>
        )}
      </div>
    </div>
  );
}

export function PackCard({
  pack,
  onView,
  onUse,
}: {
  pack: Pack;
  onView: () => void;
  onUse: () => void;
}) {
  const c = pack.contents;
  return (
    <li className="pk">
      {/*
        * The whole preview is the view control, the way a template gallery
        * works — but it is a real button with a real name, not a div with a
        * click handler, so it is reachable by keyboard and announced as what
        * it does.
        */}
      <button type="button" className="pk__preview" onClick={onView} aria-label={`What is inside ${pack.name}`}>
        <PackThumb pack={pack} />
        <span className="pk__peek">
          <svg
            width="15"
            height="15"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1.8 10S4.9 4.4 10 4.4 18.2 10 18.2 10 15.1 15.6 10 15.6 1.8 10 1.8 10Z" />
            <circle cx="10" cy="10" r="2.4" />
          </svg>
          View
        </span>
      </button>

      <div className="pk__body">
        <h3 className="pk__name">{pack.name}</h3>
        <p className="pk__summary">{pack.summary}</p>

        {/* Three facts, always the same three, so cards can be compared by
            position rather than by reading. */}
        <ul className="pk__facts">
          <li>{c.fields} questions</li>
          <li>{c.approvals === 1 ? '1 approval' : `${c.approvals} approvals`}</li>
          <li>{c.emails} messages</li>
        </ul>

        {c.policy.restrictedFields > 0 && (
          <p className="pk__flag">
            Holds {c.policy.restrictedFields} restricted field
            {c.policy.restrictedFields === 1 ? '' : 's'}
          </p>
        )}
      </div>

      <div className="pk__foot">
        <button type="button" className="pk__use" onClick={onUse} aria-label={`Use ${pack.name}`}>
          Use this
        </button>
      </div>
    </li>
  );
}

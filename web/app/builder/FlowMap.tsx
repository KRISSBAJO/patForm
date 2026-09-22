'use client';

/**
 * The process as a picture.
 *
 * A read-only view of the rules, not a second way to edit them. That is a
 * deliberate choice rather than a shortcut: a draggable canvas would become a
 * second source of truth for the same graph, and the two would disagree the
 * first time somebody edited a rule the canvas could not draw — a condition,
 * a webhook trigger, an action list. Here the rules are the truth and this is
 * a rendering of them, so it cannot drift.
 *
 * What it is for is orientation. A list of thirteen rules does not answer
 * "where does a record actually go", and that is the question somebody has
 * before they change anything.
 *
 * Layout is computed, not stored. States are placed by how far they are from
 * the start, which is the only ordering that means anything here — a saved
 * position would be one more thing to keep in step with the rules.
 */

import { useMemo } from 'react';

export interface FlowState {
  key: string;
  name: string;
  type: string;
}

export interface FlowEdge {
  key: string;
  from: string;
  to: string;
  kind: string;
}

const NODE_W = 138;
const NODE_H = 46;
const GAP_X = 58;
const GAP_Y = 18;
const PAD = 16;

/** Colour by what the state means, and a shape cue as well as a colour. */
function toneOf(type: string): { fill: string; stroke: string; dot: string } {
  if (type === 'initial') return { fill: '#ffffff', stroke: '#d7d3ca', dot: '#8f9a90' };
  if (type === 'terminal') return { fill: '#f2f8f4', stroke: '#b9d6c5', dot: '#14663f' };
  return { fill: '#ffffff', stroke: '#e6d9b8', dot: '#c99a2e' };
}

export function FlowMap({
  states,
  edges,
  selected,
  onSelect,
}: {
  states: FlowState[];
  edges: FlowEdge[];
  selected?: string;
  onSelect: (stateKey: string) => void;
}) {
  const layout = useMemo(() => {
    const byKey = new Map(states.map((s) => [s.key, s]));
    const next = new Map<string, string[]>();
    for (const e of edges) {
      if (e.from === e.to) continue;
      next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    }

    /*
     * Depth from the start, breadth first.
     *
     * A state is placed one column right of the earliest thing that reaches
     * it, so the happy path runs left to right and refusals fall out of it
     * rather than being drawn back on top.
     */
    const depth = new Map<string, number>();
    const start = states.find((s) => s.type === 'initial') ?? states[0];
    const queue: string[] = start ? [start.key] : [];
    if (start) depth.set(start.key, 0);

    while (queue.length) {
      const key = queue.shift()!;
      for (const to of next.get(key) ?? []) {
        if (depth.has(to)) continue;
        depth.set(to, depth.get(key)! + 1);
        queue.push(to);
      }
    }

    // Anything unreachable still has to appear — a state nothing reaches is
    // exactly the fault worth seeing.
    const maxDepth = Math.max(0, ...depth.values());
    for (const s of states) if (!depth.has(s.key)) depth.set(s.key, maxDepth + 1);

    const columns = new Map<number, string[]>();
    for (const s of states) {
      const d = depth.get(s.key)!;
      columns.set(d, [...(columns.get(d) ?? []), s.key]);
    }

    const at = new Map<string, { x: number; y: number }>();
    const tallest = Math.max(...[...columns.values()].map((c) => c.length));
    for (const [d, keys] of columns) {
      keys.forEach((key, i) => {
        // Each column is centred against the tallest, so the graph reads as a
        // spine rather than as a staircase.
        const offset = ((tallest - keys.length) * (NODE_H + GAP_Y)) / 2;
        at.set(key, {
          x: PAD + d * (NODE_W + GAP_X),
          y: PAD + offset + i * (NODE_H + GAP_Y),
        });
      });
    }

    const width = PAD * 2 + (Math.max(...depth.values()) + 1) * (NODE_W + GAP_X) - GAP_X;
    const height = PAD * 2 + tallest * (NODE_H + GAP_Y) - GAP_Y;

    return { at, width, height, byKey, unreachable: new Set([...states.map((s) => s.key)].filter((k) => depth.get(k)! > maxDepth)) };
  }, [states, edges]);

  if (!states.length) return null;

  return (
    <div className="fm">
      <div className="fm__scroll">
        <svg
          className="fm__svg"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          /*
           * A group, not an image. role="img" makes everything inside
           * it decoration, and these nodes are buttons — axe calls that
           * nested interactive, and it is right: a screen reader would
           * announce a picture and then find controls inside it.
           */
          role="group"
          aria-label="The path a record takes. Choose a state to see only its rules."
        >
          <defs>
            <marker id="fm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0 1 L7 4 L0 7 z" fill="#c3bfb6" />
            </marker>
          </defs>

          {edges.map((e) => {
            const a = layout.at.get(e.from);
            const b = layout.at.get(e.to);
            if (!a || !b) return null;

            if (e.from === e.to) {
              // A self-loop, drawn as a small return over the top.
              const x = a.x + NODE_W / 2;
              return (
                <path
                  key={e.key}
                  d={`M${x - 16} ${a.y} C ${x - 16} ${a.y - 22}, ${x + 16} ${a.y - 22}, ${x + 16} ${a.y}`}
                  stroke="#c3bfb6"
                  strokeWidth="1.3"
                  fill="none"
                  markerEnd="url(#fm-arrow)"
                />
              );
            }

            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            // Curves rather than elbows: several edges leaving one node stay
            // distinguishable where right angles would overlap exactly.
            return (
              <path
                key={e.key}
                d={`M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2 - 6} ${y2}`}
                stroke={e.kind === 'timer' ? '#e0cfa0' : '#c3bfb6'}
                strokeWidth="1.3"
                strokeDasharray={e.kind === 'timer' ? '4 3' : undefined}
                fill="none"
                markerEnd="url(#fm-arrow)"
              />
            );
          })}

          {states.map((s) => {
            const p = layout.at.get(s.key)!;
            const tone = toneOf(s.type);
            const isSelected = selected === s.key;
            return (
              <g
                key={s.key}
                className="fm__node"
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => onSelect(s.key)}
                role="button"
                tabIndex={0}
                aria-label={`${s.name} — show its rules`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(s.key);
                  }
                }}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx="8"
                  fill={tone.fill}
                  stroke={isSelected ? '#14663f' : tone.stroke}
                  strokeWidth={isSelected ? 2 : 1.3}
                />
                <circle cx="15" cy={NODE_H / 2} r="4" fill={tone.dot} />
                <text x="27" y={NODE_H / 2 + 4} className="fm__label">
                  {s.name.length > 17 ? `${s.name.slice(0, 16)}…` : s.name}
                </text>
                {layout.unreachable.has(s.key) && (
                  <text x="27" y={NODE_H / 2 + 16} className="fm__warn">
                    nothing reaches this
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <p className="fm__key">
        <span className="fm__keyItem">
          <span className="fm__swatch" style={{ background: '#8f9a90' }} /> the form
        </span>
        <span className="fm__keyItem">
          <span className="fm__swatch" style={{ background: '#c99a2e' }} /> waiting on somebody
        </span>
        <span className="fm__keyItem">
          <span className="fm__swatch" style={{ background: '#14663f' }} /> finished
        </span>
        <span className="fm__keyItem">
          <span className="fm__dash" /> a timer
        </span>
      </p>
    </div>
  );
}

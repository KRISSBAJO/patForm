export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** Dotted path into the blueprint, e.g. `workflow.transitions[2].actions[0]`. */
  at: string;
  /** What the builder should do about it, in plain language. */
  fix?: string;
}

export class Diagnostics {
  readonly items: Diagnostic[] = [];

  error(code: string, at: string, message: string, fix?: string): void {
    this.items.push({ code, severity: 'error', at, message, fix });
  }

  warn(code: string, at: string, message: string, fix?: string): void {
    this.items.push({ code, severity: 'warning', at, message, fix });
  }

  get errors(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'error');
  }

  get warnings(): Diagnostic[] {
    return this.items.filter((d) => d.severity === 'warning');
  }

  /** Requirement BLD-07: publishing is blocked by errors, not by warnings. */
  get publishable(): boolean {
    return this.errors.length === 0;
  }
}

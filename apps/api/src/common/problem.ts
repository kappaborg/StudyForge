/**
 * application/problem+json (RFC 9457) — the single error format for every
 * StudyForge endpoint.
 *
 * The shape MUST match the OpenAPI `Problem` schema. Adding a new field here
 * means updating openapi.yaml as well.
 */

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Stable machine code: kebab-case, dotted. e.g. "upload.size-exceeded" */
  code: string;
  /** OTel trace id of the failing request, set by the global filter. */
  traceId?: string;
  /** Tenant id of the caller, when authenticated. */
  tenantId?: string | null;
  /** Field-level details, populated by validation errors only. */
  fields?: Array<{ name: string; reason: string }>;
}

export class ProblemException extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly fields?: Array<{ name: string; reason: string }>;

  constructor(input: {
    status: number;
    code: string;
    title: string;
    detail?: string;
    fields?: Array<{ name: string; reason: string }>;
  }) {
    super(input.title);
    this.status = input.status;
    this.code = input.code;
    this.title = input.title;
    if (input.detail !== undefined) this.detail = input.detail;
    if (input.fields !== undefined) this.fields = input.fields;
  }
}

export const PROBLEM_BASE = 'https://studyforge.ai/errors';

export function problemTypeFor(code: string): string {
  return `${PROBLEM_BASE}/${code}`;
}

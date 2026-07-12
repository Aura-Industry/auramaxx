/**
 * Batch execution engine — pure logic, no Express dependency.
 *
 * Validates batch requests, builds execution waves via topological sort,
 * and resolves template references between sub-request responses.
 */

export interface BatchSubRequest {
  id: string;
  method: string;
  path: string;
  body?: Record<string, unknown>;
  dependsOn?: string;
}

export interface BatchResponse {
  status: number;
  body: unknown;
}

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const MAX_REQUESTS = 20;

// ── Validation ──

export interface ValidationSuccess {
  valid: true;
  waves: string[][];
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateBatchRequest(requests: unknown): ValidationResult {
  if (!Array.isArray(requests)) {
    return { valid: false, error: 'requests must be an array' };
  }
  if (requests.length === 0) {
    return { valid: false, error: 'requests array must not be empty' };
  }
  if (requests.length > MAX_REQUESTS) {
    return { valid: false, error: `requests array exceeds maximum of ${MAX_REQUESTS} items` };
  }

  const ids = new Set<string>();
  for (const req of requests) {
    if (!req || typeof req !== 'object') {
      return { valid: false, error: 'Each request must be an object' };
    }
    const r = req as Record<string, unknown>;

    if (typeof r.id !== 'string' || !r.id.trim()) {
      return { valid: false, error: 'Each request must have a non-empty string id' };
    }
    if (ids.has(r.id)) {
      return { valid: false, error: `Duplicate request id: ${r.id}` };
    }
    ids.add(r.id);

    if (typeof r.method !== 'string' || !VALID_METHODS.has(r.method.toUpperCase())) {
      return { valid: false, error: `Invalid method "${r.method}" for request "${r.id}". Must be GET, POST, PUT, or DELETE` };
    }

    if (typeof r.path !== 'string' || !r.path.startsWith('/')) {
      return { valid: false, error: `Invalid path for request "${r.id}". Path must start with /` };
    }

    if (r.dependsOn !== undefined) {
      if (typeof r.dependsOn !== 'string') {
        return { valid: false, error: `dependsOn must be a string for request "${r.id}"` };
      }
      if (r.dependsOn === r.id) {
        return { valid: false, error: `Request "${r.id}" cannot depend on itself` };
      }
      if (!ids.has(r.dependsOn)) {
        // Check if the target exists anywhere in the array (not just seen so far)
        const exists = requests.some((other: any) => other?.id === r.dependsOn);
        if (!exists) {
          return { valid: false, error: `Request "${r.id}" depends on unknown request "${r.dependsOn}"` };
        }
      }
    }
  }

  // Cycle detection via Kahn's algorithm
  const typed = requests as BatchSubRequest[];
  const cycleCheck = detectCycles(typed);
  if (cycleCheck) {
    return { valid: false, error: cycleCheck };
  }

  const waves = buildWaves(typed);
  return { valid: true, waves };
}

// ── Cycle Detection (Kahn's Algorithm) ──

function detectCycles(requests: BatchSubRequest[]): string | null {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> [ids that depend on it]

  for (const req of requests) {
    inDegree.set(req.id, 0);
    dependents.set(req.id, []);
  }

  for (const req of requests) {
    if (req.dependsOn) {
      inDegree.set(req.id, (inDegree.get(req.id) || 0) + 1);
      dependents.get(req.dependsOn)!.push(req.id);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const dep of dependents.get(id) || []) {
      const newDegree = (inDegree.get(dep) || 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) queue.push(dep);
    }
  }

  if (processed < requests.length) {
    return 'Circular dependency detected in requests';
  }
  return null;
}

// ── Wave Building (Topological Sort) ──

export function buildWaves(requests: BatchSubRequest[]): string[][] {
  // Map each request to its wave number
  const waveMap = new Map<string, number>();
  const requestMap = new Map<string, BatchSubRequest>();

  for (const req of requests) {
    requestMap.set(req.id, req);
  }

  // Compute wave for each request
  function getWave(id: string): number {
    if (waveMap.has(id)) return waveMap.get(id)!;

    const req = requestMap.get(id)!;
    if (!req.dependsOn) {
      waveMap.set(id, 0);
      return 0;
    }

    const depWave = getWave(req.dependsOn);
    const wave = depWave + 1;
    waveMap.set(id, wave);
    return wave;
  }

  for (const req of requests) {
    getWave(req.id);
  }

  // Group by wave
  const waves: Map<number, string[]> = new Map();
  for (const req of requests) {
    const w = waveMap.get(req.id)!;
    if (!waves.has(w)) waves.set(w, []);
    waves.get(w)!.push(req.id);
  }

  // Sort wave numbers and return arrays
  const sortedKeys = [...waves.keys()].sort((a, b) => a - b);
  return sortedKeys.map(k => waves.get(k)!);
}

// ── Template Resolution ──

export function resolveTemplates(str: string, responses: Map<string, BatchResponse>): string {
  return str.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const segments = expr.split('.');
    const requestId = segments[0];
    const pathSegments = segments.slice(1);

    const response = responses.get(requestId);
    if (!response) {
      throw new Error(`Template reference "${expr}": request "${requestId}" not found in responses`);
    }

    let current: unknown = response.body;
    for (const segment of pathSegments) {
      if (current === null || current === undefined) {
        throw new Error(`Template reference "${expr}": cannot access "${segment}" on null/undefined`);
      }
      if (typeof current === 'object') {
        // Try numeric index for arrays
        if (Array.isArray(current)) {
          const idx = parseInt(segment, 10);
          if (Number.isNaN(idx)) {
            throw new Error(`Template reference "${expr}": "${segment}" is not a valid array index`);
          }
          current = current[idx];
        } else {
          current = (current as Record<string, unknown>)[segment];
        }
      } else {
        throw new Error(`Template reference "${expr}": cannot access "${segment}" on ${typeof current}`);
      }
    }

    if (current === undefined) {
      throw new Error(`Template reference "${expr}": path not found in response`);
    }

    // Convert to string for interpolation
    if (current === null) return 'null';
    if (typeof current === 'object') return JSON.stringify(current);
    return String(current);
  });
}

export function resolveBodyTemplates(body: unknown, responses: Map<string, BatchResponse>): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') return resolveTemplates(body, responses);
  if (Array.isArray(body)) return body.map(item => resolveBodyTemplates(item, responses));
  if (typeof body === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      result[key] = resolveBodyTemplates(value, responses);
    }
    return result;
  }
  // Numbers, booleans, etc. pass through unchanged
  return body;
}

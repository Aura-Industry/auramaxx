/**
 * POST /batch — Generic batch endpoint with dependency chaining.
 *
 * Dispatches sub-requests internally against the Express app.
 * Auth is enforced per-sub-request via inherited headers.
 */
import { Router, Request, Response } from 'express';
import http from 'http';
import { Readable } from 'stream';
import { Socket } from 'net';
import {
  validateBatchRequest,
  resolveTemplates,
  resolveBodyTemplates,
  type BatchSubRequest,
  type BatchResponse,
} from '../lib/batch';

const router = Router();

const SUB_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Dispatch a sub-request internally through the Express app.
 * Creates mock req/res objects and calls app.handle().
 */
function dispatchInternal(
  app: any,
  method: string,
  fullPath: string,
  body: Record<string, unknown> | undefined,
  parentReq: Request,
): Promise<BatchResponse> {
  return new Promise((resolve) => {
    // Parse path and query string
    const [pathname, queryString] = fullPath.split('?');
    const query: Record<string, string> = {};
    if (queryString) {
      for (const pair of queryString.split('&')) {
        const [key, ...rest] = pair.split('=');
        query[decodeURIComponent(key)] = decodeURIComponent(rest.join('='));
      }
    }

    // Build JSON body as a readable stream
    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyBuf = Buffer.from(bodyStr);

    // Create a mock IncomingMessage
    const mockSocket = new Socket();
    const req = new http.IncomingMessage(mockSocket);
    req.method = method.toUpperCase();
    req.url = fullPath;
    (req as any).path = pathname;
    (req as any).query = query;
    (req as any).originalUrl = fullPath;

    // Inherit auth headers from parent request
    req.headers = {
      'content-type': 'application/json',
      host: parentReq.headers.host || 'localhost',
    };
    if (parentReq.headers.authorization) {
      req.headers.authorization = parentReq.headers.authorization;
    }

    // Set content-length for body parsing
    if (bodyStr) {
      req.headers['content-length'] = String(bodyBuf.length);
    }

    // Push body data so express.json() can parse it
    if (bodyBuf.length > 0) {
      req.push(bodyBuf);
    }
    req.push(null); // EOF

    // Create a mock ServerResponse that captures the output
    const res = new http.ServerResponse(req);
    let statusCode = 200;
    let responseBody: unknown = null;
    let resolved = false;

    // Capture status
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code: number, ...args: any[]) {
      statusCode = code;
      return origWriteHead(code, ...args);
    } as any;

    // Also capture statusCode set directly
    Object.defineProperty(res, 'statusCode', {
      get: () => statusCode,
      set: (v: number) => { statusCode = v; },
    });

    // Intercept res.end() to capture the response body
    const chunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    res.write = function (chunk: any, ...args: any[]) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return origWrite(chunk, ...args);
    } as any;

    const origEnd = res.end.bind(res);
    res.end = function (chunk?: any, ...args: any[]) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!resolved) {
        resolved = true;
        const fullBody = Buffer.concat(chunks).toString('utf-8');
        try {
          responseBody = JSON.parse(fullBody);
        } catch {
          responseBody = fullBody || null;
        }
        resolve({ status: statusCode, body: responseBody });
      }
      return origEnd(chunk, ...args);
    } as any;

    // Also intercept json() if Express adds it (belt & suspenders)
    (res as any).json = function (data: unknown) {
      if (!resolved) {
        resolved = true;
        resolve({ status: statusCode, body: data });
      }
      // Still call the real json to ensure proper cleanup
      const jsonStr = JSON.stringify(data);
      res.setHeader('Content-Type', 'application/json');
      origEnd(jsonStr);
    };

    // Timeout
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ status: 504, body: { error: 'Sub-request timed out' } });
        mockSocket.destroy();
      }
    }, SUB_REQUEST_TIMEOUT_MS);

    // Clean up timer when resolved
    const origResolve = resolve;
    const wrappedResolve = (value: BatchResponse) => {
      clearTimeout(timer);
      origResolve(value);
    };
    // Patch: the resolve calls above already fire, so clear on end
    res.on('finish', () => clearTimeout(timer));

    // Dispatch through the Express app
    app.handle(req, res);
  });
}

// ── POST /batch ──

router.post('/', async (req: Request, res: Response) => {
  const { requests } = req.body || {};

  // Validate
  const validation = validateBatchRequest(requests);
  if (!validation.valid) {
    res.status(400).json({ success: false, error: validation.error });
    return;
  }

  const { waves } = validation;
  const requestMap = new Map<string, BatchSubRequest>();
  for (const r of requests as BatchSubRequest[]) {
    requestMap.set(r.id, r);
  }

  const responses = new Map<string, BatchResponse>();
  const timings: Record<string, number> = {};

  // Execute waves sequentially
  for (const wave of waves) {
    const wavePromises = wave.map(async (id) => {
      const subReq = requestMap.get(id)!;
      const start = Date.now();

      // Check if dependency failed
      if (subReq.dependsOn) {
        const depResponse = responses.get(subReq.dependsOn);
        if (depResponse && depResponse.status >= 400) {
          const result: BatchResponse = {
            status: 424,
            body: { error: `Dependency "${subReq.dependsOn}" failed with status ${depResponse.status}` },
          };
          responses.set(id, result);
          timings[id] = Date.now() - start;
          return;
        }
      }

      // Resolve templates in path
      let resolvedPath: string;
      try {
        resolvedPath = resolveTemplates(subReq.path, responses);
      } catch (err) {
        const result: BatchResponse = {
          status: 422,
          body: { error: `Template resolution failed: ${(err as Error).message}` },
        };
        responses.set(id, result);
        timings[id] = Date.now() - start;
        return;
      }

      // Resolve templates in body
      let resolvedBody: Record<string, unknown> | undefined;
      if (subReq.body) {
        try {
          resolvedBody = resolveBodyTemplates(subReq.body, responses) as Record<string, unknown>;
        } catch (err) {
          const result: BatchResponse = {
            status: 422,
            body: { error: `Template resolution failed in body: ${(err as Error).message}` },
          };
          responses.set(id, result);
          timings[id] = Date.now() - start;
          return;
        }
      }

      // Dispatch internally
      const result = await dispatchInternal(
        req.app,
        subReq.method.toUpperCase(),
        resolvedPath,
        resolvedBody,
        req,
      );
      responses.set(id, result);
      timings[id] = Date.now() - start;
    });

    await Promise.all(wavePromises);
  }

  // Build response
  const responseObj: Record<string, { status: number; body: unknown }> = {};
  let succeeded = 0;
  let failed = 0;
  for (const [id, resp] of responses) {
    responseObj[id] = { status: resp.status, body: resp.body };
    if (resp.status < 400) {
      succeeded++;
    } else {
      failed++;
    }
  }

  res.json({
    responses: responseObj,
    meta: {
      total: responses.size,
      succeeded,
      failed,
      timings,
    },
  });
});

export default router;

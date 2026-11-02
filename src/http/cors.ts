import type { RequestListener } from 'node:http';

// Exact origins only. Firebase bearer tokens remain required by the application.
export function withCors(handler: RequestListener, configuration?: string): RequestListener {
  const origins = new Set(configuration?.split(',').map(value => value.trim()).filter(Boolean));
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('CORS_ALLOWED_ORIGINS must contain exact HTTPS origins.');
  }
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  const headers = ['authorization', 'content-type', 'idempotency-key', 'accept'];
  return (request, response) => {
    const origin = request.headers.origin;
    if (origins.size && origin) {
      response.setHeader('Vary', 'Origin');
      if (!origins.has(origin)) {
        response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { code: 'origin_not_allowed', message: 'This origin is not allowed.' } }));
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Expose-Headers', 'Retry-After, Content-Disposition, WWW-Authenticate');
      if (request.method === 'OPTIONS') {
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!methods.includes(String(request.headers['access-control-request-method'])) || requestedHeaders.some(header => !headers.includes(header))) {
          response.writeHead(403); response.end(); return;
        }
        response.writeHead(204, {
          'Access-Control-Allow-Methods': methods.join(', '),
          'Access-Control-Allow-Headers': headers.join(', '),
          'Access-Control-Max-Age': '600',
        });
        response.end();
        return;
      }
    }
    return handler(request, response);
  };
}

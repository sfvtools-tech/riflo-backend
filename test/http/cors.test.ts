import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { withCors } from '../../src/http/cors.js';

test('exact origin preflight, errors and stream headers preserve bearer authentication', async () => {
  let calls = 0;
  const origin = 'https://riflo-159b5.web.app';
  const server = createServer(withCors((request, response) => {
    calls++;
    response.writeHead(request.headers.authorization ? 200 : 401, { 'Content-Type': 'text/event-stream', 'Retry-After': '12' });
    response.end('data: {}\n\n');
  }, origin));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/projects`;
  try {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      const response = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Authorization, Content-Type, Idempotency-Key, Accept' } });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
    }
    assert.equal(calls, 0);
    for (const untrusted of ['https://evil.example', 'https://riflo-159b5.web.app.evil.example', 'null']) {
      const response = await fetch(url, { headers: { Origin: untrusted } });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    for (const headers of [{ 'Access-Control-Request-Method': 'PATCH' }, { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-Evil' }]) {
      assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, ...headers } })).status, 403);
    }
    assert.equal(calls, 0);
    const missingToken = await fetch(url, { headers: { Origin: origin } });
    assert.equal(missingToken.status, 401);
    assert.equal(missingToken.headers.get('access-control-allow-origin'), origin);
    const stream = await fetch(url, { headers: { Origin: origin, Authorization: 'Bearer fixture' } });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('access-control-allow-origin'), origin);
    assert.match(stream.headers.get('access-control-expose-headers')!, /Retry-After/);
    assert.equal(await stream.text(), 'data: {}\n\n');
    assert.equal((await fetch(url)).status, 401);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const value of ['*', 'http://example.com', 'https://example.com/', 'https://example.com/path']) assert.throws(() => withCors(() => {}, value));
});

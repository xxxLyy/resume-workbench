// test-fixtures/reliability/test-llm-post.mjs — 模型调用的「单次发送」与「禁止透明重定向」反例
// 覆盖：AUD-06（POST 禁止透明重定向）、RES-08（POST 一次发送；GET 保留有界重试）。
// 约束：只连本机回环桩（自己起的 server），零外网、零真实模型、零真实数据。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatMsgs, listModels } from '../../llm.mjs';

const fail = (m) => { console.error('❌ ' + m); process.exit(1); };

// 起一个本机回环 server；handler 由调用方给。
async function serve(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

// 隔离数据根 + 假配置（apiKey 是合成值，不连真实服务）
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-post-'));
const writeConfig = (baseURL, extra = {}) => {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    active: 0,
    profiles: [{ name: 'stub', baseURL, apiKey: 'stub-key-not-real', model: 'stub-model', ...extra }]
  }));
};
const cleanup = [];
try {
  // ===== 1. 301/302/303/307/308 重定向：第二端点 POST 计数必须为 0 =====
  for (const code of [301, 302, 303, 307, 308]) {
    let sinkPosts = 0;
    let sinkBodies = [];
    const sink = await serve((req, res) => {
      if (req.method === 'POST') {
        sinkPosts++;
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { sinkBodies.push(b); });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'LEAKED' } }] }));
    });
    cleanup.push(sink.close);
    const redirector = await serve((req, res) => {
      res.writeHead(code, { Location: `http://127.0.0.1:${sink.port}/v1/chat/completions` });
      res.end('redirect');
    });
    cleanup.push(redirector.close);
    writeConfig(`http://127.0.0.1:${redirector.port}/v1`);
    let threw = null;
    try { await chatMsgs(root, [{ role: 'user', content: '合成消息-勿外传' }]); }
    catch (e) { threw = e; }
    assert.ok(threw, `${code} 重定向必须显式失败，不得静默跟随`);
    assert.equal(sinkPosts, 0, `${code} 重定向后第二端点 POST 计数必须为 0（实际 ${sinkPosts}）`);
    assert.deepEqual(sinkBodies, [], `${code} 重定向后第二端点不得收到任何请求体`);
  }

  // ===== 2. 同 origin 重定向也不跟随 =====
  {
    let otherPosts = 0;
    const srv = await serve((req, res) => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(307, { Location: '/v1/other' });
        res.end('redirect');
        return;
      }
      if (req.method === 'POST') otherPosts++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'LEAKED' } }] }));
    });
    cleanup.push(srv.close);
    writeConfig(`http://127.0.0.1:${srv.port}/v1`);
    let threw = null;
    try { await chatMsgs(root, [{ role: 'user', content: '合成消息' }]); } catch (e) { threw = e; }
    assert.ok(threw, '同 origin 重定向也必须显式失败');
    assert.equal(otherPosts, 0, '同 origin 重定向不得把消息发到第二路径');
  }

  // ===== 3. POST 一次发送：5xx 不重发 =====
  {
    let posts = 0;
    const srv = await serve((req, res) => {
      if (req.method === 'POST') posts++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"stub-500"}');
    });
    cleanup.push(srv.close);
    writeConfig(`http://127.0.0.1:${srv.port}/v1`);
    let threw = null;
    try { await chatMsgs(root, [{ role: 'user', content: '合成消息' }]); } catch (e) { threw = e; }
    assert.ok(threw, '500 必须抛出');
    assert.equal(posts, 1, `POST 遇 5xx 只能发一次（实际 ${posts} 次）`);
  }

  // ===== 4. POST 一次发送：超时（发送后可能已计费）不重发 =====
  {
    let posts = 0;
    const srv = await serve((req) => {
      if (req.method === 'POST') posts++;
      // 故意不响应 → 由 profile 的 timeoutMs 触发超时
    });
    cleanup.push(srv.close);
    writeConfig(`http://127.0.0.1:${srv.port}/v1`, { timeoutMs: 300 });
    let threw = null;
    try { await chatMsgs(root, [{ role: 'user', content: '合成消息' }]); } catch (e) { threw = e; }
    assert.ok(threw, '超时必须抛出');
    assert.equal(posts, 1, `超时后不得重发（实际 ${posts} 次）`);
  }

  // ===== 5. POST 一次发送：发送后断连不重发 =====
  {
    let posts = 0;
    const srv = await serve((req, res) => {
      if (req.method === 'POST') { posts++; res.destroy(); return; }   // 发一半就断
      res.writeHead(200); res.end();
    });
    cleanup.push(srv.close);
    writeConfig(`http://127.0.0.1:${srv.port}/v1`);
    let threw = null;
    try { await chatMsgs(root, [{ role: 'user', content: '合成消息' }]); } catch (e) { threw = e; }
    assert.ok(threw, '断连必须抛出（结果未知，如实上报）');
    assert.equal(posts, 1, `发送后断连不得重发（实际 ${posts} 次）`);
  }

  // ===== 6. 正常路径：一次成功，计数为 1 =====
  {
    let posts = 0;
    const srv = await serve((req, res) => {
      if (req.method === 'POST') posts++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '合成回复' } }] }));
    });
    cleanup.push(srv.close);
    writeConfig(`http://127.0.0.1:${srv.port}/v1`);
    const out = await chatMsgs(root, [{ role: 'user', content: '合成消息' }]);
    assert.equal(out, '合成回复');
    assert.equal(posts, 1, '正常路径只发一次');
  }

  // ===== 7. GET /models 保留有界重试（与 POST 单次语义分离）=====
  {
    let gets = 0;
    const srv = await serve((req, res) => {
      if (req.method === 'GET') {
        gets++;
        if (gets < 3) { res.writeHead(503); res.end('busy'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    cleanup.push(srv.close);
    const models = await listModels(`http://127.0.0.1:${srv.port}/v1`, 'stub-key-not-real');
    assert.equal(gets, 3, `GET /models 遇 5xx 应做有界重试（实际 ${gets} 次）`);
    assert.deepEqual(models, ['m-a', 'm-b'], '模型列表应排序返回');
  }
  {
    // GET 遇 4xx 不重试
    let gets = 0;
    const srv = await serve((req, res) => { gets++; res.writeHead(401); res.end('no'); });
    cleanup.push(srv.close);
    let threw = null;
    try { await listModels(`http://127.0.0.1:${srv.port}/v1`, 'stub-key-not-real'); } catch (e) { threw = e; }
    assert.ok(threw, '401 必须抛出');
    assert.equal(gets, 1, 'GET 遇 4xx 不应重试');
  }
  {
    // GET 遇重定向不跟随（与 POST 同口径）
    let otherGets = 0;
    const srv = await serve((req, res) => {
      if (req.url === '/v1/models') { res.writeHead(307, { Location: '/v1/other' }); res.end(); return; }
      otherGets++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    cleanup.push(srv.close);
    let threw = null;
    try { await listModels(`http://127.0.0.1:${srv.port}/v1`, 'stub-key-not-real'); } catch (e) { threw = e; }
    assert.ok(threw, 'GET 重定向必须显式失败');
    assert.equal(otherGets, 0, 'GET 重定向不得跟随');
  }

  console.log('PASS AUD-06/RES-08: POST 禁止透明重定向（五种 3xx × 跨/同 origin）+ POST 一次发送 + GET 有界重试');
} finally {
  for (const c of cleanup) { try { await c(); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}

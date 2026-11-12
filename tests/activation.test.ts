import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Main } from '../src/main.ts';
import { reinTools } from '../src/tools.ts';

test('activation reports live capacity; offline and invalid probes never claim a connected Host', async () => {
  const root = mkdtempSync('/tmp/rein-on-');
  let host: unknown = { protocol: 1, adapter: 'codex', concurrency: 3, repository: '/project', permissions:{mode:'ask',sandbox:'read-only'},capabilities:{nativePermissionForwarding:true} };
  let probes = 0;
  const server = createServer(socket => {
    let frame = '';
    socket.on('data', chunk => {
      frame += chunk.toString();
      if (!frame.includes('\n')) return;
      assert.equal(JSON.parse(frame).type, 'probe');
      probes++;
      socket.end(JSON.stringify({ ok: true, value: host }) + '\n');
    });
  });
  const tools = reinTools(() => new Main(join(root, 'main'), { harness: 'codex', instance: 'test', session: 'activation' }, { kind: 'local', state: root }, '/project'),async()=>null);
  const mode = async (args: object) => {
    const result = await tools.find(t => t.name === 'rein_mode')!.execute(args);
    assert.ok(!result.isError);
    return JSON.parse(result.content[0]!.text);
  };
  try {
    server.listen(join(root, 'host.sock'));
    await once(server, 'listening');
    assert.equal((await mode({})).enabled, false);
    assert.equal(probes, 0);
    const online = await mode({ enabled: true });
    assert.equal(online.enabled, true);
    assert.equal(online.connection.state, 'connected');
    assert.equal(online.connection.concurrency, 3);
    assert.deepEqual(online.connection.permissions,{mode:'ask',sandbox:'read-only'});
    assert.equal(online.connection.modelAccess, 'unverified');
    assert.equal(online.approval.state,'available');
    const delegated=await mode({mode:'delegate'});
    assert.equal(delegated.mode,'delegate');assert.equal(delegated.enabled,true);
    assert.deepEqual(delegated.connection.permissions,online.connection.permissions,'Routing must not change worker access');
    assert.equal((await mode({enabled:true})).mode,'delegate','Reactivation retains this conversation route');
    assert.equal((await mode({mode:'ask'})).mode,'ask');
    const noUI=reinTools(()=>new Main(join(root,'main'),{harness:'codex',instance:'test',session:'activation'},{kind:'local',state:root},'/project'));
    const unavailable=JSON.parse((await noUI.find(t=>t.name==='rein_mode')!.execute({enabled:true})).content[0]!.text);
    assert.equal(unavailable.enabled,false);assert.equal(unavailable.approval.state,'unavailable');
    assert.match(unavailable.approval.message,/approval controls/);
    host={protocol:1,adapter:'codex',concurrency:3,repository:'/project',permissions:{mode:'ask',sandbox:'workspace-write'}};
    const incompatible=await mode({enabled:true});assert.equal(incompatible.enabled,false);assert.match(incompatible.approval.message,/not advertised/);
    host={protocol:1,adapter:'pi',concurrency:2,repository:'/project',permissions:{mode:'ask',sandbox:'read-only',worker:{adapter:'pi',tools:['read']}},approvalRequired:false,capabilities:{nativePermissionForwarding:false}};
    const headless=JSON.parse((await noUI.find(t=>t.name==='rein_mode')!.execute({enabled:true})).content[0]!.text);
    assert.equal(headless.enabled,true);assert.equal(headless.approval.state,'not_required');
    host = { protocol: 1, concurrency: 999 };
    assert.equal((await mode({ enabled: true })).connection.state, 'unavailable');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const offline = await mode({ enabled: true });
    assert.equal(offline.enabled, true);
    assert.equal(offline.connection.state, 'unavailable');
    assert.equal(offline.connection.concurrency, undefined);
    assert.equal((await mode({ enabled: false })).enabled, false);
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

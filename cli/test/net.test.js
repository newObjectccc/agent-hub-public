// 网络 / Tailscale 检测结果解析测试（mock，不真实执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listLanIps,
  tailscaleServeCommand,
  tailscaleServeHttpCommand,
  parseControlUrl,
  isOfficialControlUrl,
  parseNetcheck,
  latencyAdvice,
  parseTailscaleStatus,
  setupTailscaleServe,
} from '../lib/net.js';

const ok = (stdout) => ({ ok: true, status: 0, stdout, stderr: '', error: null });
const fail = (stderr) => ({ ok: false, status: 1, stdout: '', stderr, error: null });

test('tailscaleServeCommand: 生成确切命令', () => {
  assert.equal(tailscaleServeCommand(7700), 'tailscale serve --bg --https=443 http://127.0.0.1:7700');
});

test('tailscaleServeHttpCommand: tailnet 内 HTTP 回退命令', () => {
  assert.equal(tailscaleServeHttpCommand(7700), 'tailscale serve --bg --http=8080 http://127.0.0.1:7700');
});

test('parseControlUrl / isOfficialControlUrl: 官方 vs 自建 headscale', () => {
  assert.equal(parseControlUrl(JSON.stringify({ ControlURL: 'https://controlplane.tailscale.com' })), 'https://controlplane.tailscale.com');
  assert.equal(parseControlUrl(JSON.stringify({ ControlURL: 'https://headscale.example.com' })), 'https://headscale.example.com');
  assert.equal(parseControlUrl('not json'), '');

  assert.equal(isOfficialControlUrl('https://controlplane.tailscale.com'), true);
  assert.equal(isOfficialControlUrl(''), true); // 未知按官方（主流场景）
  assert.equal(isOfficialControlUrl('https://headscale.example.com'), false);
});

test('listLanIps: 只取非 internal 的 IPv4', () => {
  const ips = listLanIps({
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [
      { family: 'IPv6', internal: false, address: 'fe80::1' },
      { family: 'IPv4', internal: false, address: '192.168.1.23' },
    ],
  });
  assert.deepEqual(ips, [{ name: 'en0', address: '192.168.1.23' }]);
});

// 真实 netcheck 输出样本（国内家宽实测：无 IPv6、无端口映射、DERP 绕美）
const NETCHECK_SAMPLE = `Report:
\t* Time: 2026-10-08 15:32:18.40027+08:00
\t* UDP: true
\t* IPv4: yes, 171.223.196.96:43500
\t* IPv6: no, but OS has support
\t* MappingVariesByDestIP: false
\t* PortMapping: 
\t* CaptivePortal: false
\t* Nearest DERP: San Francisco
\t* DERP latency:
\t\t- sfo: 197.9ms (San Francisco)
\t\t- lax: 198.1ms (Los Angeles)
\t\t- hkg: 246ms (Hong Kong)
`;

const NETCHECK_HEALTHY = `Report:
\t* UDP: true
\t* IPv4: yes, 203.0.113.7:41641
\t* IPv6: yes, 240e::a:b:c:d
\t* MappingVariesByDestIP: false
\t* PortMapping: UPnP
\t* Nearest DERP: Hong Kong
\t* DERP latency:
\t\t- hkg: 32.1ms (Hong Kong)
\t\t- tok: 48.2ms (Tokyo)
`;

test('parseNetcheck: 解析打洞关键指标（真实样本）', () => {
  const r = parseNetcheck(NETCHECK_SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.udp, true);
  assert.equal(r.ipv4, '171.223.196.96:43500');
  assert.equal(r.ipv6, null);
  assert.equal(r.ipv6OsSupport, true);
  assert.equal(r.mappingVariesByDestIP, false);
  assert.equal(r.portMapping, null);
  assert.equal(r.nearestDerp, 'San Francisco');
  assert.equal(r.minDerpLatencyMs, 197.9);

  const healthy = parseNetcheck(NETCHECK_HEALTHY);
  assert.equal(healthy.ipv6, '240e::a:b:c:d');
  assert.equal(healthy.portMapping, 'UPnP');
  assert.equal(healthy.minDerpLatencyMs, 32.1);

  assert.equal(parseNetcheck('not netcheck output').ok, false);
  assert.equal(parseNetcheck('').ok, false);
});

test('latencyAdvice: 按优先级给可操作建议（IPv6 > 对称 NAT > 端口映射 > DERP 绕路）', () => {
  const advice = latencyAdvice(parseNetcheck(NETCHECK_SAMPLE));
  assert.equal(advice.length, 3); // 无 IPv6 + 无端口映射 + DERP 绕路（锥形 NAT 不报警）
  assert.match(advice[0], /IPv6/);
  assert.match(advice[1], /UPnP/);
  assert.match(advice[2], /San Francisco.*197\.9ms/);

  assert.deepEqual(latencyAdvice(parseNetcheck(NETCHECK_HEALTHY)), []); // 条件良好：零建议

  const symmetric = latencyAdvice(parseNetcheck(NETCHECK_HEALTHY.replace(
    'MappingVariesByDestIP: false', 'MappingVariesByDestIP: true',
  )));
  assert.equal(symmetric.length, 1);
  assert.match(symmetric[0], /对称 NAT/);

  const noUdp = latencyAdvice(parseNetcheck(NETCHECK_HEALTHY.replace('UDP: true', 'UDP: false')));
  assert.match(noUdp[0], /UDP/);

  assert.match(latencyAdvice(parseNetcheck('garbage'))[0], /无法解析/);
  assert.match(latencyAdvice(null)[0], /无法解析/);
});

test('parseTailscaleStatus: 解析 DNSName 与运行状态', () => {
  const parsed = parseTailscaleStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'my-machine.tailnet.ts.net.', Online: true },
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.running, true);
  assert.equal(parsed.dnsName, 'my-machine.tailnet.ts.net'); // 末尾点去掉

  const stopped = parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: {} }));
  assert.equal(stopped.running, false);

  assert.deepEqual(parseTailscaleStatus('not json'), { ok: false, loggedIn: false, running: false, dnsName: null, state: null });
  assert.equal(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'x.ts.net.' } })).state, 'Running');
});

test('setupTailscaleServe: 未安装 → 打印确切命令，不执行', () => {
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: false, path: null }),
    run: () => fail('should not run'),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ran, false);
  assert.equal(res.command, 'tailscale serve --bg --https=443 http://127.0.0.1:7700');
  assert.match(res.message, /未检测到 tailscale/);
});

test('setupTailscaleServe: 未登录 → 引导 tailscale up', () => {
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: (cmd, args) => (args.includes('status') ? ok(JSON.stringify({ BackendState: 'NeedsLogin', Self: {} })) : fail('nope')),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /tailscale up/);
});

test('setupTailscaleServe: 自动执行成功 → 返回 ts.net 地址', () => {
  const calls = [];
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: (cmd, args) => {
      calls.push(args.join(' '));
      return args.includes('status')
        ? ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub.tailnet.ts.net.' } }))
        : ok('serving');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.ran, true);
  assert.equal(res.tsUrl, 'https://hub.tailnet.ts.net');
  assert.ok(calls.some((c) => c.includes('serve --bg --https=443')));
});

test('setupTailscaleServe: serve 自动执行失败 → 仍打印确切命令', () => {
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: (cmd, args) => (args.includes('status')
      ? ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub.tailnet.ts.net.' } }))
      : fail('permission denied')),
  });
  assert.equal(res.ok, false);
  assert.equal(res.ran, false);
  assert.match(res.message, /手动执行/);
  assert.equal(res.command, 'tailscale serve --bg --https=443 http://127.0.0.1:7700');
});

test('setupTailscaleServe: 自建 headscale 控制面 → 走 tailnet 内 HTTP（无自动证书）', () => {
  const calls = [];
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: (cmd, args) => {
      calls.push(args.join(' '));
      if (args.includes('status')) return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'hub.tail.example.com.' } }));
      if (args.includes('debug')) return ok(JSON.stringify({ ControlURL: 'https://headscale.example.com' }));
      return ok('serving');
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'http');
  assert.equal(res.tsUrl, 'http://hub.tail.example.com:8080');
  assert.ok(calls.some((c) => c.includes('serve --bg --http=8080')));
  assert.match(res.message, /headscale/);
});

test('setupTailscaleServe: status 执行崩溃 → 提示 CLI 损坏而非误导登录', () => {
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: () => fail('Trace/BPT trap: 5'),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /二进制损坏|CLI/);
  assert.doesNotMatch(res.message, /tailscale up/);
});

test('setupTailscaleServe: 已停止 → 引导打开 App 连接', () => {
  const res = setupTailscaleServe(7700, {
    platform: 'linux',
    env: {},
    find: () => ({ found: true, path: '/usr/bin/tailscale' }),
    run: (cmd, args) => (args.includes('status')
      ? ok(JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'hub.tailnet.ts.net.' } }))
      : fail('nope')),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /已停止/);
});

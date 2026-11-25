import http from 'node:http';

function parseArgs(argv) {
  const options = {
    forge: process.env.STASH_FORGE_URL || '',
    profileId: process.env.STASH_PROFILE_ID || '1',
    devices: []
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--forge' && argv[i + 1]) options.forge = argv[++i];
    else if (arg === '--profile' && argv[i + 1]) options.profileId = argv[++i];
    else if ((arg === '--stash' || arg === '--mihomo') && argv[i + 1]) {
      options.devices.push({ kind: arg.slice(2), endpoint: argv[++i] });
    }
  }
  return options;
}

function requestUnix(socketPath, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method: 'GET', timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function fetchController(endpoint, reqPath, secret = '') {
  if (endpoint.startsWith('unix:')) {
    return requestUnix(endpoint.slice(5), reqPath);
  }
  const headers = secret ? { Authorization: `Bearer ${secret}` } : {};
  const res = await fetch(new URL(reqPath, endpoint), { headers, signal: AbortSignal.timeout(5000) });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

async function inspectForge(baseUrl, profileId, token) {
  if (!baseUrl || !token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const [snapRes, delivRes] = await Promise.all([
    fetch(new URL(`/api/profiles/${profileId}/snapshot`, baseUrl), { headers, signal: AbortSignal.timeout(8000) }),
    fetch(new URL(`/api/profiles/${profileId}/delivery`, baseUrl), { headers, signal: AbortSignal.timeout(8000) })
  ]);
  if (!snapRes.ok || !delivRes.ok) throw new Error(`Forge API error: snapshot=${snapRes.status} delivery=${delivRes.status}`);
  const snapshot = await snapRes.json();
  const delivery = await delivRes.json();
  const enabledRules = (snapshot.rules || []).filter((rule) => rule.enabled).length;
  const ruleProviderCounts = Object.fromEntries(
    (snapshot.ruleProviders || [])
      .filter((rp) => rp.providerType === 'inline')
      .map((rp) => [rp.name, Array.isArray(rp.entries) ? rp.entries.length : 0])
  );
  return {
    profileName: snapshot.profile?.name,
    revision: snapshot.profile?.revision,
    enabledRules,
    ruleProviderCounts,
    targets: Object.fromEntries(
      Object.entries(delivery.targets || {}).map(([k, v]) => [k, {
        compiledRevision: v.compiledRevision,
        readyRevision: v.readyRevision,
        current: v.current
      }])
    )
  };
}

async function inspectDevice(device, forge) {
  const { kind, endpoint } = device;
  const [ver, proxiesRes, rulesRes, rpRes, ppRes] = await Promise.all([
    fetchController(endpoint, '/version'),
    fetchController(endpoint, '/proxies'),
    fetchController(endpoint, '/rules'),
    fetchController(endpoint, '/providers/rules'),
    fetchController(endpoint, '/providers/proxies')
  ]);
  const proxies = proxiesRes.body?.proxies || {};
  const providers = ppRes.body?.providers || {};
  let aliveNodes = 0;
  let deadNodes = 0;
  const groupTypes = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Direct', 'Reject', 'RejectDrop', 'Pass', 'Compatible', 'Dns']);
  for (const [provName, prov] of Object.entries(providers)) {
    if (provName === 'default') continue;
    for (const node of prov.proxies || []) {
      if (groupTypes.has(node.type)) continue;
      if (node.alive === false) deadNodes += 1;
      else aliveNodes += 1;
    }
  }
  const pinnedSelectors = [];
  for (const [name, item] of Object.entries(proxies)) {
    if (item.type === 'Selector' && name !== 'GLOBAL' && item.now && proxies[item.now] &&
      !['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Direct', 'Reject', 'RejectDrop', 'Pass'].includes(proxies[item.now].type)) {
      pinnedSelectors.push(`${name} -> ${item.now}`);
    }
  }
  const activeRuleCount = Array.isArray(rulesRes.body?.rules) ? rulesRes.body.rules.length : null;
  const rpProviders = rpRes.body?.providers || {};
  const drift = [];
  if (forge) {
    for (const [rpName, expectedCount] of Object.entries(forge.ruleProviderCounts)) {
      const actual = rpProviders[rpName]?.ruleCount;
      if (typeof actual === 'number' && actual !== expectedCount) {
        drift.push(`${rpName}: 设备 ${actual} 条 vs 服务端 ${expectedCount} 条`);
      }
    }
  }
  return {
    kind,
    endpoint,
    version: ver.body?.version ?? 'unknown',
    activeRuleCount,
    providerNodes: { alive: aliveNodes, dead: deadNodes },
    pinnedSingleNodeSelectors: pinnedSelectors,
    ruleProviderDrift: drift,
    inSyncWithForge: forge ? drift.length === 0 : null
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.devices.length && !options.forge) {
    console.log('用法: node Scripts/check-devices.mjs [--forge http://node.tailnet.ts.net] [--profile 1] [--stash http://192.0.2.10:9090] [--mihomo unix:/var/run/clash-verge-service/users/501/verge-mihomo.sock]');
    console.log('环境变量: STASH_ADMIN_TOKEN（用于只读查询 --forge）');
    process.exit(0);
  }
  const forge = await inspectForge(options.forge, options.profileId, process.env.STASH_ADMIN_TOKEN || '');
  const results = [];
  for (const device of options.devices) {
    try {
      results.push(await inspectDevice(device, forge));
    } catch (error) {
      results.push({ kind: device.kind, endpoint: device.endpoint, error: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log(JSON.stringify({ forge, devices: results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

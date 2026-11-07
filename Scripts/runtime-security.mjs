const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || '').toLowerCase());
}

export function allowsInsecureLocalDevelopment(environment = process.env) {
  return environment.NODE_ENV === 'development' &&
    environment.STASH_ALLOW_INSECURE_LOCAL === '1';
}

export function adminAuthenticationRequired(environment = process.env) {
  return Boolean(environment.STASH_ADMIN_TOKEN?.trim()) ||
    !allowsInsecureLocalDevelopment(environment);
}

// Called before reading configuration data or opening a listening socket.
export function assertRuntimeSecurity(environment = process.env) {
  if (environment.STASH_ADMIN_TOKEN?.trim()) return;
  if (allowsInsecureLocalDevelopment(environment) && isLoopbackHost(environment.HOSTNAME)) return;
  throw new Error('STASH_ADMIN_TOKEN is required. For local development only, explicitly set NODE_ENV=development, STASH_ALLOW_INSECURE_LOCAL=1 and a loopback HOSTNAME.');
}

export function developmentRuntime(arguments_, environment = process.env) {
  const configured = { ...environment, NODE_ENV: 'development' };
  if (configured.STASH_ADMIN_TOKEN?.trim()) {
    assertRuntimeSecurity(configured);
    return { arguments: arguments_, environment: configured };
  }
  if (!allowsInsecureLocalDevelopment(configured)) assertRuntimeSecurity(configured);
  if (arguments_.includes('--')) {
    throw new Error('Unauthenticated development requires loopback hostname enforcement; the -- argument terminator is not supported.');
  }
  const filtered = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    let hostname;
    if (argument === '--hostname' || argument === '-H') {
      hostname = arguments_[++index];
    } else if (argument.startsWith('--hostname=')) {
      hostname = argument.slice('--hostname='.length);
    } else if (argument.startsWith('-H') && argument.length > 2) {
      hostname = argument.slice(2).replace(/^=/, '');
    } else {
      filtered.push(argument);
      continue;
    }
    if (!isLoopbackHost(hostname)) {
      throw new Error('Unauthenticated development must bind a loopback hostname; configure STASH_ADMIN_TOKEN to use a network interface.');
    }
  }
  configured.HOSTNAME = '127.0.0.1';
  assertRuntimeSecurity(configured);
  return { arguments: [...filtered, '--hostname', '127.0.0.1'], environment: configured };
}

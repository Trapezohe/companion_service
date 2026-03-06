export function logEvent(level, module, msg, meta) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  }
  const line = JSON.stringify(payload)
  if (level === 'error') {
    console.error(line)
    return
  }
  if (level === 'warn') {
    console.warn(line)
    return
  }
  console.log(line)
}

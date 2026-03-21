// src/automation-condition-engine.mjs
// Condition evaluation engine for workflow automation.
// FAIL-CLOSED: any error (network, invalid params, unknown type) → met: false
// This is intentional — conditions can trigger financial operations.

const CONDITION_TYPES = {
  token_price_change: async (params, deps = {}) => {
    const { tokenId, changePercent } = params
    if (!tokenId || changePercent === undefined) {
      return { met: false, value: null, threshold: changePercent, error: 'Missing required params: tokenId, changePercent' }
    }
    const fetcher = deps.priceFetcher || defaultPriceFetcher
    const { price, previousPrice } = await fetcher(tokenId)
    const actualChange = ((price - previousPrice) / previousPrice) * 100
    const met = changePercent < 0
      ? actualChange <= changePercent
      : actualChange >= changePercent
    return { met, value: actualChange, threshold: changePercent, reason: `${actualChange.toFixed(2)}% vs threshold ${changePercent}%` }
  },

  balance_threshold: async (params, deps = {}) => {
    const { address, chainId, minBalance } = params
    if (!address || !chainId || minBalance === undefined) {
      return { met: false, value: null, threshold: minBalance, error: 'Missing required params: address, chainId, minBalance' }
    }
    const fetcher = deps.balanceFetcher || defaultBalanceFetcher
    const balance = await fetcher(address, chainId)
    const met = balance >= minBalance
    return { met, value: balance, threshold: minBalance, reason: `Balance ${balance} vs threshold ${minBalance}` }
  },

  gas_price: async (params, deps = {}) => {
    const { chainId, maxGwei } = params
    if (!chainId || maxGwei === undefined) {
      return { met: false, value: null, threshold: maxGwei, error: 'Missing required params: chainId, maxGwei' }
    }
    const fetcher = deps.gasFetcher || defaultGasFetcher
    const gasPrice = await fetcher(chainId)
    const met = gasPrice <= maxGwei
    return { met, value: gasPrice, threshold: maxGwei, reason: `Gas ${gasPrice} gwei vs max ${maxGwei} gwei` }
  },
}

async function defaultPriceFetcher(tokenId) {
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(tokenId)}&vs_currencies=usd&include_24hr_change=true`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`CoinGecko API error: ${res.status}`)
  const data = await res.json()
  const entry = data[tokenId]
  if (!entry) throw new Error(`Unknown token: ${tokenId}`)
  const price = entry.usd
  const change24h = entry.usd_24h_change || 0
  const previousPrice = price / (1 + change24h / 100)
  return { price, previousPrice }
}

async function defaultBalanceFetcher(address, chainId) {
  throw new Error('Balance fetcher not configured')
}

async function defaultGasFetcher(chainId) {
  throw new Error('Gas fetcher not configured')
}

export async function evaluateCondition(condition, deps = {}) {
  const handler = CONDITION_TYPES[condition.type]
  if (!handler) {
    return { met: false, value: null, threshold: null, error: `Unknown condition type: ${condition.type}` }
  }
  try {
    return await handler(condition.params || {}, deps)
  } catch (err) {
    // FAIL-CLOSED: any error → condition not met
    return { met: false, value: null, threshold: null, error: err.message }
  }
}

export { CONDITION_TYPES }

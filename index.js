/**
 * dsh-app-badge — host half.
 *
 * Listens for session lifecycle events (e.g. turn completion or failure)
 * and maintains the unread notification badge state across clients.
 * Exposes SSE stream /dsh-app-badge/events and REST endpoints.
 */

export const name = 'dsh-app-badge'
export const inject = ['webServer']

function isTopLevel(session) {
  const depth = session?.header?.delegationDepth
  return depth === undefined || depth === 0
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

export function apply(ctx) {
  let unreadCount = 0
  const activeSseClients = new Set()
  const sessionTurnStarts = new WeakMap()

  function broadcast(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`
    for (const client of activeSseClients) {
      try {
        client.write(payload)
      } catch {
        activeSseClients.delete(client)
      }
    }
  }

  // Heartbeat to keep SSE connections alive across proxies
  const heartbeatTimer = setInterval(() => {
    for (const client of activeSseClients) {
      try {
        client.write(': heartbeat\n\n')
      } catch {
        activeSseClients.delete(client)
      }
    }
  }, 25000)

  // 1. Session turn tracking
  ctx.on('session/event', (session, event) => {
    if (!isTopLevel(session)) return

    if (event.type === 'turn/start') {
      sessionTurnStarts.set(session, Date.now())
      return
    }

    if (event.type === 'turn/end') {
      const startTime = sessionTurnStarts.get(session) || 0
      const duration = Date.now() - startTime
      const reason = event.data?.reason
      const kind = reason?.kind || 'completed'

      // Skip turns that finished instantly (< 800ms, likely no-op or instant echo)
      if (startTime > 0 && duration < 800) return

      unreadCount += 1
      broadcast({
        type: 'badge',
        count: unreadCount,
        event: 'turn/end',
        reason: kind,
        timestamp: Date.now(),
      })
      return
    }

    // Interactive waits that block and require user attention
    if (event.type === 'approval/pending' || event.type === 'wait/pending') {
      unreadCount += 1
      broadcast({
        type: 'badge',
        count: unreadCount,
        event: event.type,
        reason: 'waiting_human_action',
        timestamp: Date.now(),
      })
    }
  })

  // 2. Register HTTP routes on DSH web server
  ctx.inject(['webServer'], (web) => {
    const webServer = web.get('webServer')

    // GET /dsh-app-badge/events (SSE)
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-app-badge/events',
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
        })
        res.write(`data: ${JSON.stringify({ type: 'init', count: unreadCount })}\n\n`)

        activeSseClients.add(res)
        req.on('close', () => {
          activeSseClients.delete(res)
        })
      },
    }), 'dsh-app-badge: sse events')

    // POST /dsh-app-badge/clear
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-app-badge/clear',
      handler: (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        unreadCount = 0
        broadcast({ type: 'clear', count: 0 })
        sendJson(res, 200, { ok: true, count: 0 })
      },
    }), 'dsh-app-badge: clear badge')

    // POST /dsh-app-badge/set (Manual set for testing or external hooks)
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-app-badge/set',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const data = body ? JSON.parse(body) : {}
            const count = typeof data.count === 'number' ? Math.max(0, data.count) : unreadCount + 1
            unreadCount = count
            broadcast({ type: 'badge', count: unreadCount, source: 'manual' })
            sendJson(res, 200, { ok: true, count: unreadCount })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: err.message })
          }
        })
      },
    }), 'dsh-app-badge: manual set')

    // GET /dsh-app-badge/status
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-app-badge/status',
      handler: (req, res) => {
        sendJson(res, 200, {
          ok: true,
          unreadCount,
          activeClients: activeSseClients.size,
        })
      },
    }), 'dsh-app-badge: status')
  })

  return () => {
    clearInterval(heartbeatTimer)
    activeSseClients.clear()
  }
}

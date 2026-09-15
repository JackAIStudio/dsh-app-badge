// dsh-app-badge — client half.
//
// Interacts with W3C Badging API (navigator.setAppBadge / clearAppBadge)
// for Chrome Apps (PWA) and Electron shells (like JackDSH), with document.title
// fallback for standard browser tabs.

window.__ModuleLoader__.load({
  id: 'dsh-app-badge',
  factory: (require) => {
    const module = { exports: {} }

    let currentCount = 0
    let sseSource = null
    let reconnectTimeout = null
    let badgeLeaderRelease = null
    let badgeChannel = null
    let lastPeerPresentAt = 0
    let presenceTimer = null

    function stripTitleBadge(title) {
      return (title || '').replace(/^\(\d+\)\s*/, '')
    }

    function applyTitleBadge(count) {
      if (typeof document === 'undefined') return
      const baseTitle = stripTitleBadge(document.title)
      if (count > 0) {
        document.title = `(${count}) ${baseTitle}`
      } else {
        document.title = baseTitle
      }
    }

    function setBadge(count) {
      currentCount = Math.max(0, count)
      applyTitleBadge(currentCount)

      // 1. JackDSH Electron native bridge
      if (typeof window !== 'undefined' && window.jackdshNative && typeof window.jackdshNative.setBadge === 'function') {
        try { window.jackdshNative.setBadge(currentCount) } catch {}
      }

      // 2. W3C Badging API (Chrome PWA / polyfilled)
      if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
        if (currentCount > 0) {
          navigator.setAppBadge(currentCount).catch(() => {})
        } else {
          navigator.clearAppBadge().catch(() => {})
        }
      }
    }

    function clearBadge() {
      currentCount = 0
      applyTitleBadge(0)

      // 1. JackDSH Electron native bridge
      if (typeof window !== 'undefined' && window.jackdshNative && typeof window.jackdshNative.clearBadge === 'function') {
        try { window.jackdshNative.clearBadge() } catch {}
      }

      // 2. W3C Badging API (Chrome PWA / polyfilled)
      if (typeof navigator !== 'undefined' && 'clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {})
      }
    }

    function isUserAway() {
      if (typeof document === 'undefined') return false
      return document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())
    }

    function sendClearToHost() {
      if (typeof fetch === 'function') {
        fetch('/dsh-app-badge/clear', {
          method: 'POST',
          credentials: 'same-origin',
        }).catch(() => {})
      }
    }

    function handleUserPresent() {
      if (currentCount > 0) {
        clearBadge()
        sendClearToHost()
      }
    }

    function showDesktopNotification(data) {
      const isJackDsh = typeof window !== 'undefined' && Boolean(window.jackdshNative)

      // 1. JackDSH 极简沉静体验：桌面端不弹系统横幅、不弹跳，只靠声音知当下、红点知过往
      if (isJackDsh) {
        return
      }

      // 2. 浏览器 Web Notification 兜底
      if (typeof window === 'undefined' || !('Notification' in window)) return
      if (Notification.permission !== 'granted') return

      try {
        const title = 'DeepSeek Harness'
        const body = data.reason === 'waiting_human_action'
          ? '等待处理人工审批或操作'
          : (data.reason === 'error' ? '任务执行遇到异常' : '后台任务已执行完成')
        const notice = new Notification(title, {
          body,
          tag: 'dsh-app-badge-alert',
          renotify: true,
        })
        notice.onclick = () => {
          window.focus()
          notice.close()
        }
      } catch {}
    }

    function connectSse() {
      if (typeof window === 'undefined' || typeof EventSource === 'undefined') return

      if (sseSource) {
        try { sseSource.close() } catch {}
        sseSource = null
      }

      try {
        sseSource = new EventSource('/dsh-app-badge/events')

        sseSource.onmessage = (event) => {
          if (!event.data) return
          try {
            const data = JSON.parse(event.data)
            if (data.type === 'badge') {
              const isJackDsh = typeof window !== 'undefined' && Boolean(window.jackdshNative)
              // 在 JackDSH 桌面原生客户端环境下，是唯一的独立窗口，无需受多标签 peer presence 抑制！
              const someonePresent = isJackDsh ? false : (Date.now() - lastPeerPresentAt < 12000)
              if (isUserAway() && !someonePresent) {
                setBadge(data.count || currentCount + 1)
                showDesktopNotification(data)
                publishBadgeState()
              } else {
                // User is actively looking at the screen, clear immediately
                sendClearToHost()
              }
            } else if (data.type === 'clear') {
              clearBadge()
              publishBadgeState()
            } else if (data.type === 'init') {
              if (isUserAway() && data.count > 0) {
                setBadge(data.count)
              }
              publishBadgeState()
            }
          } catch {}
        }

        sseSource.onerror = () => {
          try { sseSource.close() } catch {}
          sseSource = null
          clearTimeout(reconnectTimeout)
          reconnectTimeout = setTimeout(connectSse, 5000)
        }
      } catch {}
    }

    /**
     * Mirror the badge count to sibling tabs, so the leader is the only tab
     * that needs a live connection while every tab still shows the count.
     */
    function publishBadgeState() {
      if (!badgeChannel) return
      try { badgeChannel.postMessage({ type: 'state', count: currentCount }) } catch {}
    }

    function subscribeBadgeState() {
      if (typeof BroadcastChannel === 'undefined') return
      try {
        badgeChannel = new BroadcastChannel('dsh-app-badge')
        badgeChannel.onmessage = (event) => {
          const data = event.data
          if (!data) return
          if (data.type === 'present') {
            lastPeerPresentAt = Date.now()
            return
          }
          if (data.type === 'state' && typeof data.count === 'number') setBadge(data.count)
        }
      } catch {}
    }

    /** Tell the leader tab that this tab is on screen, so it can stay quiet. */
    function announcePresence() {
      if (!badgeChannel) return
      try { badgeChannel.postMessage({ type: 'present' }) } catch {}
    }

    /**
     * Only one tab may hold the badge stream. Every tab would otherwise open
     * its own EventSource, and Chrome allows only ~6 concurrent HTTP
     * connections per host — two long-lived streams per tab is what caps how
     * many DSH tabs can be open before new requests stop being served.
     *
     * Web Locks gives the election for free: the lock is held for as long as
     * the tab lives and released automatically when it closes or crashes, at
     * which point the next waiting tab takes over the stream.
     */
    function startBadgeLeader() {
      if (typeof navigator === 'undefined' || !navigator.locks || typeof navigator.locks.request !== 'function') {
        connectSse()
        return
      }
      navigator.locks.request('dsh-app-badge-leader', () => {
        connectSse()
        return new Promise((resolve) => {
          badgeLeaderRelease = resolve
        })
      }).catch(() => {
        // Locks unusable in this shell: fall back to the old per-tab stream.
        connectSse()
      })
    }

    function init() {
      // 1. Clean up any previous HMR instance
      if (window.__dshAppBadgeInstance) {
        window.__dshAppBadgeInstance.dispose()
      }

      const isJackDsh = typeof window !== 'undefined' && Boolean(window.jackdshNative)

      // 2. Setup user interaction listeners
      const onFocus = () => {
        announcePresence()
        handleUserPresent()
      }
      const onVisibility = () => {
        if (!document.hidden) {
          announcePresence()
          // 在桌面客户端中，切出到后台时 document.hidden 依然为 false，绝不能在无焦点时误清空角标
          if (!isJackDsh || (typeof document.hasFocus === 'function' && document.hasFocus())) {
            handleUserPresent()
          }
        }
      }

      window.addEventListener('focus', onFocus)
      window.addEventListener('click', onFocus)
      document.addEventListener('visibilitychange', onVisibility)

      // JackDSH 原生窗口激活时同步清空角标
      if (typeof window !== 'undefined' && window.jackdshNative?.onWindowFocused) {
        window.jackdshNative.onWindowFocused(() => {
          announcePresence()
          handleUserPresent()
        })
      }

      // Keep the leader tab informed while this tab stays on screen, so a
      // background leader never notifies about something the user is watching.
      announcePresence()
      presenceTimer = setInterval(() => {
        if (!document.hidden) announcePresence()
      }, 5000)

      // 3. Connect SSE event stream
      subscribeBadgeState()
      startBadgeLeader()

      // 4. Register instance cleanup
      const dispose = () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('click', onFocus)
        document.removeEventListener('visibilitychange', onVisibility)
        clearTimeout(reconnectTimeout)
        clearInterval(presenceTimer)
        presenceTimer = null
        if (badgeLeaderRelease) {
          try { badgeLeaderRelease() } catch {}
          badgeLeaderRelease = null
        }
        if (badgeChannel) {
          try { badgeChannel.close() } catch {}
          badgeChannel = null
        }
        if (sseSource) {
          try { sseSource.close() } catch {}
          sseSource = null
        }
      }

      window.__dshAppBadgeInstance = { dispose }

      // 5. Expose debug/manual interface
      window.__dshAppBadge = {
        set: (n) => setBadge(n),
        clear: () => {
          clearBadge()
          sendClearToHost()
        },
        getCount: () => currentCount,
        requestNotificationPermission: () => {
          if ('Notification' in window && Notification.permission === 'default') {
            return Notification.requestPermission()
          }
          return Promise.resolve(Notification.permission)
        },
      }

      console.info('[dsh-app-badge] ready: app badge notifications initialized.')
    }

    init()

    module.exports.inject = ['connection']
    module.exports.apply = function apply() {}
    return module.exports
  },
})

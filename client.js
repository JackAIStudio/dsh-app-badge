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
              if (isUserAway()) {
                setBadge(data.count || currentCount + 1)
                showDesktopNotification(data)
              } else {
                // User is actively looking at the screen, clear immediately
                sendClearToHost()
              }
            } else if (data.type === 'clear') {
              clearBadge()
            } else if (data.type === 'init') {
              if (isUserAway() && data.count > 0) {
                setBadge(data.count)
              }
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

    function init() {
      // 1. Clean up any previous HMR instance
      if (window.__dshAppBadgeInstance) {
        window.__dshAppBadgeInstance.dispose()
      }

      // 2. Setup user interaction listeners
      const onFocus = () => handleUserPresent()
      const onVisibility = () => {
        if (!document.hidden) handleUserPresent()
      }

      window.addEventListener('focus', onFocus)
      window.addEventListener('click', onFocus)
      document.addEventListener('visibilitychange', onVisibility)

      // 3. Connect SSE event stream
      connectSse()

      // 4. Register instance cleanup
      const dispose = () => {
        window.removeEventListener('focus', onFocus)
        window.removeEventListener('click', onFocus)
        document.removeEventListener('visibilitychange', onVisibility)
        clearTimeout(reconnectTimeout)
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

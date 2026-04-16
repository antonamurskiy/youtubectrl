import { useEffect, useRef } from 'react'
import { useUIStore } from '../stores/ui'

// Serialize UI state → URL search params
function stateToParams(tab, searchQuery, channelQuery) {
  const p = new URLSearchParams()
  if (tab && tab !== 'rec') p.set('tab', tab)
  if (tab === 'search' && searchQuery) p.set('q', searchQuery)
  if (tab === 'channel' && channelQuery) {
    if (channelQuery.id) p.set('ch', channelQuery.id)
    if (channelQuery.name) p.set('name', channelQuery.name)
    if (channelQuery.platform) p.set('platform', channelQuery.platform)
  }
  return p.toString()
}

// Deserialize URL search params → UI state
function paramsToState(search) {
  const p = new URLSearchParams(search)
  const tab = p.get('tab') || 'rec'
  const searchQuery = p.get('q') || ''
  const channelQuery = tab === 'channel'
    ? { id: p.get('ch') || undefined, name: p.get('name') || undefined, platform: p.get('platform') || undefined }
    : null
  return { tab, searchQuery, channelQuery }
}

export function useRouting() {
  const skipPush = useRef(false)

  // On mount: restore state from URL (only if different from default)
  useEffect(() => {
    const { tab, searchQuery, channelQuery } = paramsToState(window.location.search)
    const store = useUIStore.getState()
    const needsUpdate = tab !== store.activeTab || searchQuery !== store.searchQuery || !!channelQuery !== !!store.channelQuery
    if (!needsUpdate) {
      // Replace current history entry so back works from the initial page
      window.history.replaceState({ tab: store.activeTab }, '', window.location.pathname + window.location.search)
      return
    }
    skipPush.current = true
    if (searchQuery) store.setSearch(searchQuery)
    if (channelQuery) {
      store.setChannel(channelQuery)
    } else {
      store.setTab(tab)
    }
    skipPush.current = false
  }, [])

  // Subscribe to store changes → pushState
  useEffect(() => {
    let prev = stateToParams(
      useUIStore.getState().activeTab,
      useUIStore.getState().searchQuery,
      useUIStore.getState().channelQuery
    )

    const unsub = useUIStore.subscribe((state) => {
      if (skipPush.current) return
      const next = stateToParams(state.activeTab, state.searchQuery, state.channelQuery)
      if (next !== prev) {
        prev = next
        const url = next ? `?${next}` : window.location.pathname
        window.history.pushState({ tab: state.activeTab, q: state.searchQuery, ch: state.channelQuery }, '', url)
      }
    })
    return unsub
  }, [])

  // Listen for popstate (back/forward)
  useEffect(() => {
    const onPop = () => {
      const { tab, searchQuery, channelQuery } = paramsToState(window.location.search)
      const store = useUIStore.getState()
      skipPush.current = true
      store.setSearch(searchQuery)
      if (channelQuery) {
        store.setChannel(channelQuery)
      } else {
        store.setTab(tab)
      }
      skipPush.current = false
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
}

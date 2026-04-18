import { create } from 'zustand'

// Grid style: 'compact' (small thumb on the left, info on the right — like
// mobile YouTube search results) or 'wide' (full-width thumbnail stacked
// on top of title/channel/meta — like the official YouTube mobile app
// home feed). Persisted to localStorage so the preference survives reloads.
const GRID_STYLE_KEY = 'ytctl-grid-style'
function loadGridStyle() {
  try {
    const v = localStorage.getItem(GRID_STYLE_KEY)
    if (v === 'wide' || v === 'compact') return v
  } catch {}
  return 'compact'
}

export const useUIStore = create((set) => ({
  activeTab: 'rec',
  searchQuery: '',
  channelQuery: null, // { id, name } for channel tab
  secretMenuOpen: false,
  toasts: [],
  loadGen: 0, // generation counter to discard stale responses
  refreshKey: 0, // increment to trigger VideoGrid refresh
  refreshing: false,
  setRefreshing: (v) => set({ refreshing: v }),
  cachedVolume: null, // persists across SecretMenu open/close
  setCachedVolume: (v) => set({ cachedVolume: v }),
  filteredVideos: [], // ads filtered from recommended feed
  setFilteredVideos: (v) => set({ filteredVideos: v }),
  gridStyle: loadGridStyle(),
  setGridStyle: (style) => {
    try { localStorage.setItem(GRID_STYLE_KEY, style) } catch {}
    set({ gridStyle: style })
  },

  setTab: (tab) => set({ activeTab: tab }),
  setSearch: (q) => set({ searchQuery: q }),
  setChannel: (ch) => set({ channelQuery: ch, activeTab: 'channel' }),
  toggleSecretMenu: () => set((s) => ({ secretMenuOpen: !s.secretMenuOpen })),
  addToast: (msg) => set((s) => {
    const id = Date.now()
    setTimeout(() => set((s2) => ({ toasts: s2.toasts.filter(t => t.id !== id) })), 3000)
    return { toasts: [...s.toasts, { id, msg }] }
  }),
  nextLoadGen: () => set((s) => ({ loadGen: s.loadGen + 1 })),
  refresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),
}))

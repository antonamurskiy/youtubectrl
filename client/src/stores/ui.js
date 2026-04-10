import { create } from 'zustand'

export const useUIStore = create((set) => ({
  activeTab: 'rec',
  searchQuery: '',
  channelQuery: null, // { id, name } for channel tab
  secretMenuOpen: false,
  toasts: [],
  loadGen: 0, // generation counter to discard stale responses
  refreshKey: 0, // increment to trigger VideoGrid refresh
  cachedVolume: null, // persists across SecretMenu open/close
  setCachedVolume: (v) => set({ cachedVolume: v }),
  filteredVideos: [], // ads filtered from recommended feed
  setFilteredVideos: (v) => set({ filteredVideos: v }),

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

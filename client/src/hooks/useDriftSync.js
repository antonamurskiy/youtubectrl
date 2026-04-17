import { useEffect, useRef } from 'react'
import { usePlaybackStore } from '../stores/playback'
import { useSyncStore } from '../stores/sync'
import { isNativeIOS, NativePlayer } from '../native/player'

// Native AVPlayer position cache — polled separately so sync doesn't have
// to await on every drift check.
let _nativePos = 0
let _nativePosAt = 0
let _lastVodSeek = 0

function nativePosNow() {
  // Interpolate from last poll assuming rate=1
  const elapsed = (Date.now() - _nativePosAt) / 1000
  return _nativePos + elapsed
}

export function useDriftSync(videoRef, getPlayingDate, send) {
  useEffect(() => {
    if (!isNativeIOS) return
    // Poll AVPlayer position every 250ms so nativePosNow has fresh base
    let alive = true
    const tick = async () => {
      if (!alive) return
      try {
        const s = await NativePlayer.getState()
        if (s && typeof s.position === 'number') {
          _nativePos = s.position
          _nativePosAt = Date.now()
        }
      } catch {}
      if (alive) setTimeout(tick, 250)
    }
    tick()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const unsub = usePlaybackStore.subscribe((pb) => {
      if (!pb.playing || pb.paused) return
      const video = videoRef.current
      const phonePos = isNativeIOS ? nativePosNow() : video?.currentTime
      if (!phonePos || phonePos < 1) return
      // Non-native: also need HTML video ready
      if (!isNativeIOS && (!video || video.readyState < 2)) return

      const sync = useSyncStore.getState()
      if (!sync.phoneOpen) return
      if (Date.now() < sync.settleUntil) return

      const behindLive = pb.duration - pb.position

      if (pb.isLive) {
        syncLive(pb, video, phonePos, getPlayingDate, send, sync, behindLive)
      } else {
        syncVod(pb, video, phonePos, send, sync)
      }
    })

    return unsub
  }, [videoRef, getPlayingDate, send])
}

function syncLive(pb, video, phonePos, getPlayingDate, send, sync, behindLive) {
  // Get absolute time from hls.js (Chrome) or native (Safari)
  const phoneAbsMs = getPlayingDate()
  if (!phoneAbsMs || !pb.absoluteMs) return

  const store = useSyncStore.getState()
  const drift = (pb.absoluteMs - phoneAbsMs) / 1000 + store.userOffset
  if (Math.abs(drift) > 100) return
  store.setDrift(drift)
  send({ type: 'phone-state', drift: +drift.toFixed(2), behindLive: +behindLive.toFixed(0) })

  // Used to nudge VLC rate here; dropped with the VLC removal. mpv live
  // ignores rate anyway (Safari HLS + iOS AVPlayer don't honor rate for
  // live either), so drift-chasing was always aspirational.
}

function syncVod(pb, video, phonePos, send, sync) {
  // pb.position is from mpv's last broadcast (~1s old at most). Extrapolate
  // forward by the wall-clock time since the broadcast so we compare the
  // phone against where mpv actually IS now, not where it was 500ms ago.
  let mpvNow = pb.position
  if (pb.serverTs) {
    const elapsed = (Date.now() + (sync.clockOffset || 0) - pb.serverTs) / 1000
    if (elapsed > 0 && elapsed < 5) mpvNow = pb.position + elapsed
  }

  const drift = mpvNow - phonePos
  useSyncStore.getState().setDrift(drift)
  send({ type: 'phone-state', drift: +drift.toFixed(2), mpv: +mpvNow.toFixed(1), phone: +phonePos.toFixed(1) })

  // Pause/resume
  if (isNativeIOS) {
    // Native AVPlayer already respects its paused state. Use NativePlayer
    // instead of HTML video's paused.
    // Note: we don't fight for pause sync here because the NowPlayingBar
    // play/pause already drives both mpv + AVPlayer through phoneVideoCtrl.
  } else if (video) {
    if (pb.paused && !video.paused) video.pause()
    else if (!pb.paused && video.paused) video.play().catch(() => {})
  }

  // VOD sync is hard-seek only — rate-nudging destabilizes the system
  // (AVPlayer + mpv oscillate, never converge). Threshold is 0.2s with
  // a 5s cooldown to avoid thrashing the decoder. Add +0.5s seek-latency
  // compensation so the phone lands near where mpv will be once the
  // seek completes (rather than where mpv was when we started seeking).
  const now = Date.now()
  if (Math.abs(drift) > 0.2 && (now - _lastVodSeek) > 5000) {
    _lastVodSeek = now
    const target = mpvNow + 0.5
    if (isNativeIOS) {
      NativePlayer.seek(target).catch(() => {})
      _nativePos = target
      _nativePosAt = Date.now()
    } else if (video) {
      video.currentTime = target
    }
    useSyncStore.getState().setSettling(Date.now() + 2000)
  }
}

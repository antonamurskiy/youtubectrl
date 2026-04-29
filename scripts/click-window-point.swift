#!/usr/bin/env swift
// click-window-point.swift — synthesize a left-click at a point
// inside an app's window, addressed by screenshot-pixel coordinates.
// Works even when the target window is positioned off-screen
// (stealth mode) by posting CGEvents directly to the owning PID
// rather than going through screen hit-testing.
//
// Usage:
//   click-window-point <owner-substring> <px_x> <px_y> <screenshot_w_px> <screenshot_h_px>
//
// Conversion: the screenshot is in native pixels; the window's
// CGWindowBounds are in logical points. scale = window_w / screenshot_w
// (HiDPI / Retina / 1280-vs-2560 LG resolution all collapse into the
// same ratio, so no need to read the display's backing scale factor
// separately).
//
// Exits 0 on click posted, 1 on window not found, 2 on bad args.

import Foundation
import CoreGraphics
import AppKit

guard CommandLine.arguments.count == 6 else {
    FileHandle.standardError.write(
        "usage: click-window-point <owner> <px_x> <px_y> <screenshot_w_px> <screenshot_h_px>\n"
            .data(using: .utf8)!)
    exit(2)
}
let needle = CommandLine.arguments[1].lowercased()
let pxX = Double(CommandLine.arguments[2]) ?? 0
let pxY = Double(CommandLine.arguments[3]) ?? 0
let pxW = Double(CommandLine.arguments[4]) ?? 1
let pxH = Double(CommandLine.arguments[5]) ?? 1

guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID)
        as? [[String: Any]] else { exit(1) }

var best: (pid: pid_t, x: Double, y: Double, w: Double, h: Double, area: Double) =
    (0, 0, 0, 0, 0, 0)
for info in list {
    let owner = (info[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    if !owner.contains(needle) { continue }
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    if layer != 0 { continue }
    guard let b = info[kCGWindowBounds as String] as? [String: Any] else { continue }
    let x = (b["X"] as? Double) ?? Double((b["X"] as? Int) ?? 0)
    let y = (b["Y"] as? Double) ?? Double((b["Y"] as? Int) ?? 0)
    let w = (b["Width"] as? Double) ?? Double((b["Width"] as? Int) ?? 0)
    let h = (b["Height"] as? Double) ?? Double((b["Height"] as? Int) ?? 0)
    let area = w * h
    if area < 200 * 200 { continue }
    let pid = pid_t(info[kCGWindowOwnerPID as String] as? Int ?? 0)
    if area > best.area {
        best = (pid, x, y, w, h, area)
    }
}
if best.pid == 0 { exit(1) }

// HiDPI / resolution collapse: window_w (logical) / screenshot_w (pixels)
// Independent in x/y to handle non-square scaling edge case.
let scaleX = best.w / pxW
let scaleY = best.h / pxH
let cx = best.x + pxX * scaleX
let cy = best.y + pxY * scaleY

let pt = CGPoint(x: cx, y: cy)
let src = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown,
                   mouseCursorPosition: pt, mouseButton: .left)
let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp,
                 mouseCursorPosition: pt, mouseButton: .left)
// postToPid bypasses screen hit-testing — delivers to FM regardless
// of whether (cx, cy) sits over a visible portion of the window.
down?.postToPid(best.pid)
usleep(20_000)
up?.postToPid(best.pid)
print("\(cx),\(cy)")

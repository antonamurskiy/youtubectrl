#!/usr/bin/env swift
// find-window-id.swift — print CGWindowID of the largest on-screen
// window whose owner name contains the given substring. Used to
// target `screencapture -l <id>` at an app's main window even when
// it sits on an unfocused aerospace workspace (stealth mode).
// Usage: find-window-id.swift "<owner substring>"

import Foundation
import CoreGraphics
import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: find-window-id.swift <owner-substring>\n".data(using: .utf8)!)
    exit(2)
}
let needle = CommandLine.arguments[1].lowercased()

guard let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}

var best: (id: Int, area: Int) = (0, 0)
for info in list {
    let owner = (info[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    if !owner.contains(needle) { continue }
    let layer = info[kCGWindowLayer as String] as? Int ?? 0
    if layer != 0 { continue }
    guard let b = info[kCGWindowBounds as String] as? [String: Any] else { continue }
    let w = (b["Width"] as? Double).map(Int.init) ?? (b["Width"] as? Int ?? 0)
    let h = (b["Height"] as? Double).map(Int.init) ?? (b["Height"] as? Int ?? 0)
    let area = w * h
    if area < 200 * 200 { continue } // skip tiny child panels
    let id = info[kCGWindowNumber as String] as? Int ?? 0
    if area > best.area { best = (id, area) }
}

if best.id == 0 { exit(1) }
print(best.id)

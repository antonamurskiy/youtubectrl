// road-walk.swift — pixel-level road network reachability from a pin.
//
// Why this exists: the geometric perpendicular-distance heuristic
// (server.js:nearestCrossStreet) doesn't know about barriers like
// train tracks or water. A pin on Palmetto St with Admiral Ave on
// the OTHER SIDE of train tracks gets ranked as if Admiral were
// nearby in straight-line terms — but you can't actually walk there.
//
// Approach (no ML / no LLM):
//   1. Auto-calibrate the "street pixel color" by sampling around
//      OCR street-label centers. Each label sits ON a road; the
//      pixels in a small ring around its center are guaranteed to
//      be road color (after filtering out the bright text itself).
//   2. Build a binary road mask via the calibrated color ± tolerance.
//   3. BFS from the pin along that mask. Buildings, tracks, parks,
//      and water are all NOT in the mask — they're walls. The set
//      of reachable pixels = road network connected to the pin.
//   4. For each labeled street, find the nearest reachable pixel
//      within ~50px of its label center. Streets across a barrier
//      have NO reachable pixel and drop out automatically.
//   5. Return closest reachable label = STREET-ON-PIN; next-closest
//      DIFFERENT label = CROSS-STREET.
//
// Input: image path as argv[1]; JSON on stdin:
//   {"pin":{"x":1797,"y":742}, "labels":[{"name":"Palmetto St","x":1332,"y":865,"w":149,"h":73}, ...]}
// Output: JSON on stdout: {"streetOnPin":"...","crossStreet":"..."}
//   or exit 2 with no output if calibration / BFS fails.

import Foundation
import AppKit
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: road-walk <png>  (json on stdin)\n".data(using: .utf8)!)
    exit(1)
}
let path = CommandLine.arguments[1]

// Read JSON config from stdin.
let stdinData = FileHandle.standardInput.readDataToEndOfFile()
guard let configAny = try? JSONSerialization.jsonObject(with: stdinData),
      let config = configAny as? [String: Any],
      let pinObj = config["pin"] as? [String: Any],
      let pinX = (pinObj["x"] as? NSNumber)?.intValue,
      let pinY = (pinObj["y"] as? NSNumber)?.intValue,
      let labelsRaw = config["labels"] as? [[String: Any]] else {
    FileHandle.standardError.write("bad json on stdin\n".data(using: .utf8)!)
    exit(1)
}

struct Label { let name: String; let cx: Int; let cy: Int; let w: Int; let h: Int }
var labels: [Label] = []
for l in labelsRaw {
    guard let name = l["name"] as? String,
          let x = (l["x"] as? NSNumber)?.intValue,
          let y = (l["y"] as? NSNumber)?.intValue,
          let w = (l["w"] as? NSNumber)?.intValue,
          let h = (l["h"] as? NSNumber)?.intValue else { continue }
    labels.append(Label(name: name, cx: x + w / 2, cy: y + h / 2, w: w, h: h))
}
if labels.isEmpty { exit(2) }

guard let nsImage = NSImage(contentsOfFile: path),
      let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("failed to load image\n".data(using: .utf8)!)
    exit(1)
}
let W = cgImage.width
let H = cgImage.height

let bytesPerRow = W * 4
var pixels = [UInt8](repeating: 0, count: W * H * 4)
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
guard let context = CGContext(
    data: &pixels, width: W, height: H,
    bitsPerComponent: 8, bytesPerRow: bytesPerRow,
    space: colorSpace, bitmapInfo: bitmapInfo.rawValue
) else { exit(1) }
context.draw(cgImage, in: CGRect(x: 0, y: 0, width: W, height: H))

@inline(__always) func pixel(_ x: Int, _ y: Int) -> (Int, Int, Int) {
    let i = (y * W + x) * 4
    return (Int(pixels[i]), Int(pixels[i+1]), Int(pixels[i+2]))
}

// Calibrate road color. In dark-mode Apple Maps the brightness
// ladder is: text (V > 200) > buildings (V ~ 130-160) > ROADS
// (V ~ 105-125) > background terrain (V ~ 90-110) > tracks (V < 90).
// The label bbox always contains some road pixels (label is ON the
// road) but ALSO building pixels (bbox is wider than the road strip).
// To target roads specifically, filter samples to V ∈ [105, 130]
// — excludes buildings on the bright side and background on the dark.
var roadSamples: [(Int, Int, Int)] = []
for l in labels {
    let halfW = max(10, l.w / 2 - 2)
    let halfH = max(8, l.h / 2 - 2)
    let stepX = max(1, l.w / 24), stepY = max(1, l.h / 12)
    for sy in stride(from: l.cy - halfH, through: l.cy + halfH, by: stepY) {
        for sx in stride(from: l.cx - halfW, through: l.cx + halfW, by: stepX) {
            if sx < 0 || sx >= W || sy < 0 || sy >= H { continue }
            let p = pixel(sx, sy)
            let mx = max(p.0, max(p.1, p.2))
            if mx >= 105 && mx <= 130 { roadSamples.append(p) }
        }
    }
}
if roadSamples.count < 24 {
    FileHandle.standardError.write("calibration failed: only \(roadSamples.count) road samples\n".data(using: .utf8)!)
    exit(2)
}

// Per-channel median.
func median(_ vals: [Int]) -> Int {
    var v = vals; v.sort(); return v[v.count / 2]
}
let medR = median(roadSamples.map { $0.0 })
let medG = median(roadSamples.map { $0.1 })
let medB = median(roadSamples.map { $0.2 })

// isRoad: pixel must be in the road brightness band V ∈ [100, 132]
// (slightly wider than calibration band to capture road edge pixels)
// AND match calibrated road hue (low saturation, channel ordering
// preserved). Excludes:
//   - buildings (V > 132)
//   - text (V > 200)
//   - background (V < 100)
//   - parks / water (saturation > 50, or wrong hue ordering)
@inline(__always) func isRoad(_ x: Int, _ y: Int) -> Bool {
    let p = pixel(x, y)
    let mx = max(p.0, max(p.1, p.2))
    let mn = min(p.0, min(p.1, p.2))
    if mx < 110 || mx > 135 { return false }
    if (mx - mn) > 65 { return false }
    // Hue check: blue-grey roads have B > G > R typically.
    if (medB > medR) && !(p.2 >= p.0 - 5) { return false }
    if (medG > medR) && !(p.1 >= p.0 - 5) { return false }
    // Per-channel sanity vs calibration.
    if abs(p.0 - medR) > 25 { return false }
    if abs(p.1 - medG) > 25 { return false }
    if abs(p.2 - medB) > 25 { return false }
    return true
}

// Pin might land on the friend silhouette icon, not the road itself.
// Spiral out up to 100px to find the nearest road pixel as our BFS seed.
var startX = pinX, startY = pinY
if !isRoad(startX, startY) {
    outer: for r in 1...100 {
        for thetaIdx in 0..<32 {
            let theta = Double(thetaIdx) * .pi / 16
            let sx = pinX + Int(cos(theta) * Double(r))
            let sy = pinY + Int(sin(theta) * Double(r))
            if sx < 0 || sx >= W || sy < 0 || sy >= H { continue }
            if isRoad(sx, sy) { startX = sx; startY = sy; break outer }
        }
    }
}
if !isRoad(startX, startY) {
    let p = pixel(pinX, pinY)
    FileHandle.standardError.write("no road near pin (\(pinX),\(pinY)). pin pixel=\(p), road median=(\(medR),\(medG),\(medB))\n".data(using: .utf8)!)
    exit(2)
}
if ProcessInfo.processInfo.environment["ROADWALK_DEBUG"] != nil {
    FileHandle.standardError.write("calibrated road=(\(medR),\(medG),\(medB)); BFS start=(\(startX),\(startY))\n".data(using: .utf8)!)
}

// Optional: dump road mask as PNG to ROADWALK_DEBUG_MASK path.
if let dumpPath = ProcessInfo.processInfo.environment["ROADWALK_DEBUG_MASK"] {
    var maskBytes = [UInt8](repeating: 0, count: W * H * 4)
    for y in 0..<H {
        for x in 0..<W {
            let v: UInt8 = isRoad(x, y) ? 255 : 0
            let i = (y * W + x) * 4
            maskBytes[i] = v; maskBytes[i+1] = v; maskBytes[i+2] = v; maskBytes[i+3] = 255
        }
    }
    let cs = CGColorSpaceCreateDeviceRGB()
    let bi = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    let prov = CGDataProvider(data: Data(maskBytes) as CFData)!
    if let mImg = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W*4, space: cs, bitmapInfo: bi, provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
        let url = URL(fileURLWithPath: dumpPath)
        if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, mImg, nil)
            CGImageDestinationFinalize(dest)
            FileHandle.standardError.write("wrote mask to \(dumpPath)\n".data(using: .utf8)!)
        }
    }
}

// Count reachable pixels post-BFS so we can tell if BFS is escaping
// or stuck on an island.
var reachedCount = 0
var maxDistSeen: Int32 = 0

// Precompute the isRoad mask once into a byte array, then dilate by
// 2 pixels with a 5×5 square. Roads in dark-mode Apple Maps fragment
// at intersections (anti-aliased gradients and lighter junction
// pixels fall outside our V-band), so a strict mask gives a
// disconnected road network. Dilation closes those <5px gaps without
// merging into adjacent buildings (which are always farther).
let pixCount = W * H
var rawMask = [UInt8](repeating: 0, count: pixCount)
for y in 0..<H {
    for x in 0..<W {
        if isRoad(x, y) { rawMask[y * W + x] = 1 }
    }
}
// Dilate: for each non-mask pixel, set to 1 if any neighbor within
// radius 2 is a mask pixel. Two horizontal+vertical passes give a
// box dilation of effective radius 2.
var dilated = rawMask
let R_DILATE = 2
// Horizontal pass.
var tmp = [UInt8](repeating: 0, count: pixCount)
for y in 0..<H {
    let rowBase = y * W
    for x in 0..<W {
        var v: UInt8 = 0
        let x0 = max(0, x - R_DILATE), x1 = min(W - 1, x + R_DILATE)
        for k in x0...x1 { if rawMask[rowBase + k] == 1 { v = 1; break } }
        tmp[rowBase + x] = v
    }
}
// Vertical pass.
for x in 0..<W {
    for y in 0..<H {
        var v: UInt8 = 0
        let y0 = max(0, y - R_DILATE), y1 = min(H - 1, y + R_DILATE)
        for k in y0...y1 { if tmp[k * W + x] == 1 { v = 1; break } }
        dilated[y * W + x] = v
    }
}

// 8-connected BFS over dilated road mask. dist[idx] = step count
// from start. Cap at MAX_DIST steps.
var dist = [Int32](repeating: -1, count: pixCount)
let MAX_DIST: Int32 = 2500
let startIdx = startY * W + startX
dist[startIdx] = 0
var queue: [Int] = [startIdx]
queue.reserveCapacity(400_000)
var head = 0
let neighbors: [(Int, Int)] = [(1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)]
while head < queue.count {
    let idx = queue[head]; head += 1
    let d = dist[idx]
    if d >= MAX_DIST { continue }
    let cx = idx % W
    let cy = idx / W
    for (dx, dy) in neighbors {
        let nx = cx + dx, ny = cy + dy
        if nx < 0 || nx >= W || ny < 0 || ny >= H { continue }
        let n = ny * W + nx
        if dist[n] != -1 { continue }
        if dilated[n] == 0 { continue }
        dist[n] = d + 1
        queue.append(n)
    }
}

if ProcessInfo.processInfo.environment["ROADWALK_DEBUG"] != nil {
    for d in dist { if d != -1 { reachedCount += 1; if d > maxDistSeen { maxDistSeen = d } } }
    FileHandle.standardError.write("BFS reached \(reachedCount) px, max dist=\(maxDistSeen)\n".data(using: .utf8)!)
}

// Optional: dump BFS visited set as PNG to ROADWALK_DEBUG_VISITED path.
if let dumpPath = ProcessInfo.processInfo.environment["ROADWALK_DEBUG_VISITED"] {
    var vBytes = [UInt8](repeating: 0, count: W * H * 4)
    for y in 0..<H {
        for x in 0..<W {
            let idx = y * W + x
            let i = idx * 4
            if dist[idx] != -1 {
                vBytes[i] = 100; vBytes[i+1] = 255; vBytes[i+2] = 100  // green = visited
            } else if isRoad(x, y) {
                vBytes[i] = 80; vBytes[i+1] = 80; vBytes[i+2] = 80     // grey = road but unreachable
            }
            vBytes[i+3] = 255
        }
    }
    let cs = CGColorSpaceCreateDeviceRGB()
    let bi = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
    let prov = CGDataProvider(data: Data(vBytes) as CFData)!
    if let mImg = CGImage(width: W, height: H, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: W*4, space: cs, bitmapInfo: bi, provider: prov, decode: nil, shouldInterpolate: false, intent: .defaultIntent) {
        let url = URL(fileURLWithPath: dumpPath)
        if let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) {
            CGImageDestinationAddImage(dest, mImg, nil)
            CGImageDestinationFinalize(dest)
        }
    }
}

// For each label, scan a 100×100 window around the label center and
// take the minimum reachable distance. Labels whose entire window has
// dist=-1 are unreachable from the pin (across a barrier) and drop out.
struct LabelDist { let name: String; let d: Int32 }
var ranked: [LabelDist] = []
for l in labels {
    var minD: Int32 = .max
    let x0 = max(0, l.cx - 50), x1 = min(W, l.cx + 50)
    let y0 = max(0, l.cy - 50), y1 = min(H, l.cy + 50)
    for sy in y0..<y1 {
        let rowBase = sy * W
        for sx in x0..<x1 {
            let d = dist[rowBase + sx]
            if d != -1 && d < minD { minD = d }
        }
    }
    if minD != .max {
        ranked.append(LabelDist(name: l.name, d: minD))
    }
}
if ranked.isEmpty {
    FileHandle.standardError.write("no labels reachable\n".data(using: .utf8)!)
    exit(2)
}
if ProcessInfo.processInfo.environment["ROADWALK_DEBUG"] != nil {
    for r in ranked.sorted(by: { $0.d < $1.d }) {
        FileHandle.standardError.write("  \(r.name): dist=\(r.d)\n".data(using: .utf8)!)
    }
}
ranked.sort { $0.d < $1.d }

// Dedupe by name — keep the closest instance.
var seen = Set<String>()
var unique: [LabelDist] = []
for r in ranked {
    if seen.contains(r.name) { continue }
    seen.insert(r.name)
    unique.append(r)
}
let streetOnPin = unique[0].name
let crossStreet = unique.dropFirst().first(where: { $0.name != streetOnPin })?.name

var result: [String: String] = ["streetOnPin": streetOnPin]
if let c = crossStreet { result["crossStreet"] = c }
let out = try! JSONSerialization.data(withJSONObject: result)
print(String(data: out, encoding: .utf8)!)

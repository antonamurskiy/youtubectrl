// find-pin.swift — locate Apple Maps' selected-friend pin in a Find My
// screenshot via white-silhouette-inside-circle detection.
//
// The friend pin renders as a colored/grey circle (~80-150px diameter
// at retina) with a white person silhouette inside. The silhouette
// is a small (~80-300 px area) compact cluster of white pixels with a
// distinctive head+shoulders shape. This is more specific than "any
// bright circle" — there are also halo/selection rings on the map
// that are bright but EMPTY (no internal silhouette).
//
// Algorithm:
//   1. Find connected components of white pixels (RGB ≥ 240) in map
//      area (skip People panel).
//   2. Filter: compact bbox aspect (0.5-2.0), size 50-600px, density
//      > 0.5 (rejects text labels which are sparse rectangles).
//   3. For each candidate, sample a ring at r=18-35 around centroid;
//      require uniformly mid-grey pixels (the pin body color, NOT
//      bright text background, NOT map terrain).
//   4. Output centroid x,y of best-scoring cluster.

import Foundation
import AppKit

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("usage: find-pin.swift <png>\n".data(using: .utf8)!)
    exit(1)
}
let path = CommandLine.arguments[1]
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

@inline(__always) func sample(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int) {
    let i = (y * W + x) * 4
    return (Int(pixels[i]), Int(pixels[i+1]), Int(pixels[i+2]))
}

// Build white-pixel mask, restricted to map area (skip the People
// panel on the left ~30% of the image).
let mapStartX = Int(Double(W) * 0.30)
var white = [Bool](repeating: false, count: W * H)
for y in 0..<H {
    for x in mapStartX..<W {
        let p = sample(x, y)
        if p.r >= 240 && p.g >= 240 && p.b >= 240 {
            white[y * W + x] = true
        }
    }
}

// 4-connected flood fill to find components.
struct Component { var minX: Int; var minY: Int; var maxX: Int; var maxY: Int; var area: Int; var sumX: Int; var sumY: Int }
var visited = [Bool](repeating: false, count: W * H)
var components: [Component] = []

for y in 0..<H {
    for x in mapStartX..<W {
        let idx = y * W + x
        if !white[idx] || visited[idx] { continue }
        var comp = Component(minX: x, minY: y, maxX: x, maxY: y, area: 0, sumX: 0, sumY: 0)
        var stack: [(Int, Int)] = [(x, y)]
        visited[idx] = true
        while let (cx, cy) = stack.popLast() {
            comp.area += 1
            comp.sumX += cx; comp.sumY += cy
            comp.minX = min(comp.minX, cx); comp.maxX = max(comp.maxX, cx)
            comp.minY = min(comp.minY, cy); comp.maxY = max(comp.maxY, cy)
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let nx = cx + dx; let ny = cy + dy
                if nx < mapStartX || nx >= W || ny < 0 || ny >= H { continue }
                let nidx = ny * W + nx
                if !white[nidx] || visited[nidx] { continue }
                visited[nidx] = true
                stack.append((nx, ny))
            }
            // Cap stack growth on huge components (text mass) — they
            // can't be the pin silhouette anyway.
            if comp.area > 2000 { break }
        }
        if comp.area >= 50 && comp.area <= 800 {
            components.append(comp)
        }
    }
}

struct Candidate { let cx: Int; let cy: Int; let score: Double }
var best: Candidate? = nil

for c in components {
    let bw = c.maxX - c.minX + 1
    let bh = c.maxY - c.minY + 1
    let cx = c.sumX / c.area
    let cy = c.sumY / c.area
    let aspect = Double(bw) / Double(bh)
    if aspect < 0.4 || aspect > 2.5 { continue }
    let density = Double(c.area) / Double(bw * bh)
    if density < 0.4 { continue }  // text labels are sparse

    // Sample a ring at r=20..40 around centroid. The pin body should
    // be a fairly uniform mid-grey (RGB roughly 90-180, low saturation).
    var ringMatch = 0, ringTotal = 0
    var ringMeanR = 0, ringMeanG = 0, ringMeanB = 0
    for r in [22, 28, 35] {
        for thetaIdx in 0..<16 {
            let theta = Double(thetaIdx) * .pi / 8
            let sx = cx + Int(cos(theta) * Double(r))
            let sy = cy + Int(sin(theta) * Double(r))
            if sx < 0 || sx >= W || sy < 0 || sy >= H { continue }
            let p = sample(sx, sy)
            ringMeanR += p.r; ringMeanG += p.g; ringMeanB += p.b
            ringTotal += 1
            // Pin body is greyish — channels close to each other and
            // mid-brightness. Reject text labels (background dark map)
            // by requiring the ring to NOT be the dark map background
            // (RGB < 80 across the board).
            let mx = max(p.r, max(p.g, p.b))
            let mn = min(p.r, min(p.g, p.b))
            let isGreyish = (mx - mn) < 50 && mx >= 70 && mx <= 220
            if isGreyish { ringMatch += 1 }
        }
    }
    if ringTotal == 0 { continue }
    let ringRatio = Double(ringMatch) / Double(ringTotal)
    if ringRatio < 0.45 { continue }  // most of ring should be pin body

    // Score: prefer compact, dense, well-formed silhouettes with a
    // strong pin body around them.
    let score = ringRatio + density * 0.5 - abs(1.0 - aspect) * 0.3
    if best == nil || score > best!.score {
        best = Candidate(cx: cx, cy: cy, score: score)
    }
}

guard let pin = best else { exit(2) }
print("\(pin.cx),\(pin.cy)")

#!/usr/bin/env swift
// ocr.swift — run Apple Vision OCR on an image and print one line per
// detected text with bounding box: "x,y,w,h\ttext"
// Usage: ocr.swift <path-to-image>

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: ocr.swift <image>\n".data(using: .utf8)!)
    exit(2)
}

let imgPath = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: imgPath),
      let cgImage = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("failed to load image\n".data(using: .utf8)!)
    exit(1)
}

let req = VNRecognizeTextRequest { (request, error) in
    guard error == nil, let observations = request.results as? [VNRecognizedTextObservation] else {
        FileHandle.standardError.write("ocr failed\n".data(using: .utf8)!)
        exit(1)
    }
    let w = CGFloat(cgImage.width)
    let h = CGFloat(cgImage.height)
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        // bounding box is normalized, bottom-left origin. Convert to
        // top-left origin pixels.
        let bx = Int(obs.boundingBox.minX * w)
        let by = Int((1 - obs.boundingBox.maxY) * h)
        let bw = Int(obs.boundingBox.width * w)
        let bh = Int(obs.boundingBox.height * h)
        // Text baseline angle from the rotated quadrangle. Vision
        // returns four corners of the (rotated) bounding rect; the
        // baseline runs from bottomLeft to bottomRight. In Vision's
        // bottom-left-origin normalized coords, dy is inverted vs the
        // image-pixel top-left coords we output, so flip Y to match.
        let bl = obs.bottomLeft, br = obs.bottomRight
        let dx = (br.x - bl.x) * w
        let dy = -(br.y - bl.y) * h    // flip to top-left-origin
        let angleDeg = Int((atan2(dy, dx) * 180.0 / .pi).rounded())
        let line = "\(bx),\(by),\(bw),\(bh),\(angleDeg)\t\(top.string)"
        print(line)
    }
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
// Catch smaller street labels at lower display resolutions / wider
// map views. Default minimumTextHeight is ~0.03125 (1/32 of the
// shorter image dimension) which drops street-name labels at certain
// zoom levels (e.g. PALMETTO ST disappearing while LINDEN ST and
// GATES AVE are still detected). Halve it.
req.minimumTextHeight = 0.005

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("perform failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

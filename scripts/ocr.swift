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
        let line = "\(bx),\(by),\(bw),\(bh)\t\(top.string)"
        print(line)
    }
}
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([req])
} catch {
    FileHandle.standardError.write("perform failed: \(error)\n".data(using: .utf8)!)
    exit(1)
}

import UIKit
import SwiftUI
import Observation
import CoreText

/// Mirrors React's `client/src/fonts.js` — 11 monospace families
/// downloadable from Google Fonts, persisted to UserDefaults, plus a
/// font-size scrubber. iOS-bundled fonts (Menlo, Courier, SF Mono) used
/// directly; the rest are fetched on first selection and registered
/// with Core Text so SwiftUI / UIKit / SwiftTerm can use them by name.
@Observable
@MainActor
final class FontStore {
    static var shared: FontStore?
    struct Entry { let label: String; let postScript: String; let cssFamily: String?; let bundled: Bool }

    static let entries: [Entry] = [
        .init(label: "SF Mono",         postScript: "<system>",                cssFamily: nil,                  bundled: true),
        .init(label: "Menlo",           postScript: "Menlo-Regular",           cssFamily: nil,                  bundled: true),
        .init(label: "Courier",         postScript: "Courier",                 cssFamily: nil,                  bundled: true),
        .init(label: "JetBrains Mono",  postScript: "JetBrainsMono-Regular",   cssFamily: "JetBrains+Mono",     bundled: false),
        .init(label: "IBM Plex Mono",   postScript: "IBMPlexMono",             cssFamily: "IBM+Plex+Mono",      bundled: false),
        .init(label: "Space Mono",      postScript: "SpaceMono-Regular",       cssFamily: "Space+Mono",         bundled: false),
        .init(label: "Geist Mono",      postScript: "GeistMono-Regular",       cssFamily: "Geist+Mono",         bundled: false),
        .init(label: "Fira Code",       postScript: "FiraCode-Regular",        cssFamily: "Fira+Code",          bundled: false),
        .init(label: "DM Mono",         postScript: "DMMono-Regular",          cssFamily: "DM+Mono",            bundled: false),
        .init(label: "Red Hat Mono",    postScript: "RedHatMono-Regular",      cssFamily: "Red+Hat+Mono",       bundled: false),
        .init(label: "Azeret Mono",     postScript: "AzeretMono-Regular",      cssFamily: "Azeret+Mono",        bundled: false),
        .init(label: "Monaspace Neon",  postScript: "MonaspaceNeon-Regular",   cssFamily: "Monaspace+Neon",     bundled: false),
        .init(label: "Martian Mono",    postScript: "MartianMono-Regular",     cssFamily: "Martian+Mono",       bundled: false),
        .init(label: "Commit Mono",     postScript: "CommitMono-Regular",      cssFamily: "Commit+Mono",        bundled: false),
    ]

    static let sizes: [CGFloat] = [10, 11, 12, 13, 14, 15, 16]
    private static let labelKey = "vids.font.label"
    private static let sizeKey = "vids.font.size"
    private static let defaultSize: CGFloat = 13

    var label: String
    var size: CGFloat
    private(set) var registered: Set<String> = []
    /// Maps a label to the actual PostScript name discovered after
    /// downloading + registering the .ttf. Google Fonts files don't
    /// always match our hardcoded guesses (e.g. JetBrains Mono ships
    /// "JetBrainsMonoRoman-Regular" not "JetBrainsMono-Regular").
    private(set) var resolvedNames: [String: String] = [:]
    /// Bumps when a download finishes — views observing this property
    /// re-render and pick up the newly-available font.
    private(set) var generation: Int = 0

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.labelKey)
        self.label = Self.entries.first(where: { $0.label == saved })?.label ?? Self.entries[0].label
        let savedSize = UserDefaults.standard.double(forKey: Self.sizeKey)
        self.size = savedSize > 0 ? CGFloat(savedSize) : Self.defaultSize
        Self.shared = self
        // Trigger registration of the saved font on launch so it's
        // ready before any view tries to render with it.
        ensureRegistered(label: self.label)
    }

    func setLabel(_ new: String) {
        label = new
        UserDefaults.standard.set(new, forKey: Self.labelKey)
        ensureRegistered(label: new)
    }

    func setSize(_ new: CGFloat) {
        size = new
        UserDefaults.standard.set(Double(new), forKey: Self.sizeKey)
        generation += 1
    }

    /// Returns a UIFont for the active font + size, falling back to
    /// monospacedSystemFont if the family isn't loaded yet.
    func font(size: CGFloat? = nil) -> UIFont {
        let s = size ?? self.size
        let entry = Self.entries.first(where: { $0.label == label }) ?? Self.entries[0]
        if entry.postScript == "<system>" {
            return UIFont.monospacedSystemFont(ofSize: s, weight: .regular)
        }
        if let resolved = resolvedNames[label], let f = UIFont(name: resolved, size: s) { return f }
        if let f = UIFont(name: entry.postScript, size: s) { return f }
        return UIFont.monospacedSystemFont(ofSize: s, weight: .regular)
    }

    /// Resolved PostScript name for the active font (or nil if the
    /// system font is selected / family isn't registered yet).
    func resolvedPostScript() -> String? {
        guard let entry = Self.entries.first(where: { $0.label == label }),
              entry.postScript != "<system>"
        else { return nil }
        if let resolved = resolvedNames[label],
           UIFont(name: resolved, size: 12) != nil { return resolved }
        if UIFont(name: entry.postScript, size: 12) != nil { return entry.postScript }
        return nil
    }

    func ensureRegistered(label: String) {
        guard let entry = Self.entries.first(where: { $0.label == label }),
              !entry.bundled,
              let css = entry.cssFamily
        else {
            generation += 1
            return
        }
        // Already loaded?
        if resolvedNames[label] != nil || UIFont(name: entry.postScript, size: 12) != nil {
            generation += 1
            return
        }
        if registered.contains(label) { return }
        registered.insert(label)
        Task.detached { [weak self] in
            let name = await self?.downloadAndRegister(family: css)
            await MainActor.run {
                if let n = name { self?.resolvedNames[label] = n }
                self?.generation += 1
            }
        }
    }

    private func downloadAndRegister(family: String) async -> String? {
        guard let cssURL = URL(string: "https://fonts.googleapis.com/css2?family=\(family):wght@400&display=swap") else { return nil }
        var req = URLRequest(url: cssURL)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        guard let (cssData, _) = try? await URLSession.shared.data(for: req),
              let css = String(data: cssData, encoding: .utf8) else { return nil }
        let pattern = #"url\((https://[^)]+\.ttf)\)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: css, range: NSRange(css.startIndex..., in: css)),
              let urlRange = Range(match.range(at: 1), in: css),
              let ttfURL = URL(string: String(css[urlRange])),
              let (ttfData, _) = try? await URLSession.shared.data(from: ttfURL)
        else { return nil }
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dest = cacheDir.appendingPathComponent("\(family).ttf")
        try? ttfData.write(to: dest)
        var error: Unmanaged<CFError>?
        CTFontManagerRegisterFontsForURL(dest as CFURL, .process, &error)
        // Read the actual PostScript name out of the registered file.
        // The hardcoded guesses (e.g. "JetBrainsMono-Regular") often
        // don't match what the TTF declares (e.g.
        // "JetBrainsMonoRoman-Regular"), causing UIFont(name:) lookups
        // to fail and the app to fall back to .system.
        guard let provider = CGDataProvider(url: dest as CFURL) else { return nil }
        let cgFont = CGFont(provider)
        return cgFont?.postScriptName as String?
    }
}

extension Font {
    /// App-wide font derived from the user's FontStore selection. Use
    /// instead of .system(size:weight:) so font picker changes propagate
    /// to every Text/Label without re-touching every callsite.
    @MainActor
    static func app(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        guard let store = FontStore.shared,
              let postScript = store.resolvedPostScript()
        else {
            return .system(size: size, weight: weight, design: design)
        }
        _ = store.generation  // tie observation
        return .custom(postScript, size: size).weight(weight)
    }
}

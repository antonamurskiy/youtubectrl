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
    struct Entry {
        let label: String
        let postScript: String
        let directURL: String?  // jsdelivr CDN ttf — preferred over Google Fonts CSS
        let cssFamily: String?  // Google Fonts CSS endpoint family param
        let bundled: Bool
    }

    static let entries: [Entry] = [
        .init(label: "SF Mono",         postScript: "<system>",                directURL: nil, cssFamily: nil,                  bundled: true),
        .init(label: "Menlo",           postScript: "Menlo-Regular",           directURL: nil, cssFamily: nil,                  bundled: true),
        .init(label: "Courier",         postScript: "Courier",                 directURL: nil, cssFamily: nil,                  bundled: true),
        // jsdelivr-hosted github raw ttfs — bypass Google Fonts CSS
        // negotiation that was returning variable woff2 we can't read.
        // JetBrains Mono is bundled directly in the app so it's always
        // available — runtime download was failing due to repo path
        // changes on jsdelivr.
        .init(label: "JetBrains Mono",  postScript: "JetBrainsMono-Regular",   directURL: nil, cssFamily: nil,                  bundled: true),
        // jsdelivr @master pin works (default branch path moved).
        .init(label: "IBM Plex Mono",   postScript: "IBMPlexMono",             directURL: "https://cdn.jsdelivr.net/gh/IBM/plex@master/IBM-Plex-Mono/fonts/complete/ttf/IBMPlexMono-Regular.ttf",                                      cssFamily: "IBM+Plex+Mono",      bundled: false),
        .init(label: "Space Mono",      postScript: "SpaceMono-Regular",       directURL: "https://cdn.jsdelivr.net/gh/googlefonts/spacemono@main/fonts/SpaceMono-Regular.ttf",                                                       cssFamily: "Space+Mono",         bundled: false),
        .init(label: "Fira Code",       postScript: "FiraCode-Regular",        directURL: "https://cdn.jsdelivr.net/gh/tonsky/FiraCode@master/distr/ttf/FiraCode-Regular.ttf",                                                        cssFamily: "Fira+Code",          bundled: false),
        .init(label: "DM Mono",         postScript: "DMMono-Regular",          directURL: "https://cdn.jsdelivr.net/gh/googlefonts/dm-mono@main/fonts/ttf/DMMono-Regular.ttf",                                                        cssFamily: "DM+Mono",            bundled: false),
        .init(label: "Red Hat Mono",    postScript: "RedHatMono-Regular",      directURL: "https://cdn.jsdelivr.net/gh/RedHatOfficial/RedHatFont@master/fonts/static/RedHatMono/RedHatMono-Regular.ttf",                              cssFamily: "Red+Hat+Mono",       bundled: false),
        .init(label: "Geist Mono",      postScript: "GeistMono-Regular",       directURL: nil,                                                                                                                                       cssFamily: "Geist+Mono",         bundled: false),
        .init(label: "Azeret Mono",     postScript: "AzeretMono-Regular",      directURL: nil,                                                                                                                                       cssFamily: "Azeret+Mono",        bundled: false),
        .init(label: "Monaspace Neon",  postScript: "MonaspaceNeon-Regular",   directURL: nil,                                                                                                                                       cssFamily: "Monaspace+Neon",     bundled: false),
        .init(label: "Martian Mono",    postScript: "MartianMono-Regular",     directURL: nil,                                                                                                                                       cssFamily: "Martian+Mono",       bundled: false),
        .init(label: "Commit Mono",     postScript: "CommitMono-Regular",      directURL: nil,                                                                                                                                       cssFamily: "Commit+Mono",        bundled: false),
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
        // (Bundled fonts auto-load via Info.plist UIAppFonts — explicit
        //  CTFontManagerRegisterFontsForURL was double-registering and
        //  putting JetBrainsMono into a stale state. Reverted.)
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
        // Cascade JBM → Menlo (has ✽✱✻✼ spinner dingbats) →
        // Apple Symbols (has ⎿ bracket + box drawing variants) →
        // Apple Color Emoji (has misc rich symbols). Without an
        // explicit cascade, iOS's implicit cascade for custom-
        // registered fonts (JBM is bundled, not system) doesn't
        // reliably fall through to the right font for these glyphs
        // and they render as .notdef boxes.
        if let resolved = resolvedNames[label], let f = UIFont(name: resolved, size: s) {
            return Self.withCascade(f)
        }
        if let f = UIFont(name: entry.postScript, size: s) {
            return Self.withCascade(f)
        }
        // Try matching by family name as a last resort — bundled fonts
        // sometimes load under their family rather than PostScript name
        // depending on Info.plist / iOS font registration timing.
        let family = entry.label.replacingOccurrences(of: " ", with: "")
        if let f = UIFont(name: family + "-Regular", size: s) { return f }
        if let f = UIFont(name: family, size: s) { return f }
        // Walk family fontNames and grab the first match.
        for fam in UIFont.familyNames where fam.replacingOccurrences(of: " ", with: "").lowercased() == family.lowercased() {
            for n in UIFont.fontNames(forFamilyName: fam) {
                if let f = UIFont(name: n, size: s) {
                    NSLog("[FontStore] resolved %@ via family scan → %@", entry.label, n)
                    resolvedNames[label] = n
                    return f
                }
            }
        }
        NSLog("[FontStore] FAILED to resolve %@ (postScript=%@) — falling back to system mono", entry.label, entry.postScript)
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

    /// Wrap the primary font in a CTFontDescriptor cascade list. Order
    /// matters: each fallback is tried in sequence for any glyph the
    /// primary font lacks. Menlo handles the dingbat spinner (✽ ✱ ✻);
    /// Apple Symbols handles bracket + technical chars (⎿ ⏵ ⏸); emoji
    /// is a final catch-all for emoji content.
    private static func withCascade(_ primary: UIFont) -> UIFont {
        let cascade: [UIFontDescriptor] = [
            UIFontDescriptor(name: "Menlo-Regular", size: primary.pointSize),
            UIFontDescriptor(name: "AppleSymbols", size: primary.pointSize),
            UIFontDescriptor(name: "AppleColorEmoji", size: primary.pointSize),
        ]
        let desc = primary.fontDescriptor.addingAttributes([.cascadeList: cascade])
        return UIFont(descriptor: desc, size: primary.pointSize)
    }

    func ensureRegistered(label: String) {
        guard let entry = Self.entries.first(where: { $0.label == label }),
              !entry.bundled
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
            // Prefer the direct CDN ttf (always works); fall back to
            // Google Fonts CSS scrape if no direct URL is configured.
            let name: String?
            if let direct = entry.directURL, let url = URL(string: direct) {
                name = await self?.downloadAndRegisterDirect(url: url, label: label)
            } else if let css = entry.cssFamily {
                name = await self?.downloadAndRegister(family: css)
            } else {
                name = nil
            }
            await MainActor.run {
                if let n = name { self?.resolvedNames[label] = n }
                self?.generation += 1
            }
        }
    }

    private func downloadAndRegisterDirect(url: URL, label: String) async -> String? {
        guard let (data, _) = try? await URLSession.shared.data(from: url) else {
            NSLog("[FontStore] direct download failed: \(url)")
            return nil
        }
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let dest = cacheDir.appendingPathComponent("\(label).ttf")
        try? data.write(to: dest)
        guard let provider = CGDataProvider(url: dest as CFURL),
              let cgFont = CGFont(provider) else { return nil }
        let postScript = cgFont.postScriptName as String?
        var cferr: Unmanaged<CFError>?
        let ok = CTFontManagerRegisterGraphicsFont(cgFont, &cferr)
        NSLog("[FontStore] direct register \(label): postScript=\(postScript ?? "nil") ok=\(ok)")
        if !ok, let ps = postScript, UIFont(name: ps, size: 12) != nil { return ps }
        return ok ? postScript : nil
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
        // Read the PostScript name from the file, then register via the
        // CGFont path (more reliable than CTFontManagerRegisterFontsForURL
        // for cached-and-replayed fonts).
        guard let provider = CGDataProvider(url: dest as CFURL),
              let cgFont = CGFont(provider) else {
            NSLog("[FontStore] CGFont creation failed for \(family)")
            return nil
        }
        let postScript = cgFont.postScriptName as String?
        var cferr: Unmanaged<CFError>?
        let registered = CTFontManagerRegisterGraphicsFont(cgFont, &cferr)
        NSLog("[FontStore] register \(family): postScript=\(postScript ?? "nil") ok=\(registered)")
        if !registered {
            // Maybe it's already registered from a previous launch — verify.
            if let ps = postScript, UIFont(name: ps, size: 12) != nil {
                return ps
            }
            return nil
        }
        return postScript
    }
}

extension Font {
    /// App-wide font derived from the user's FontStore selection. Use
    /// instead of .system(size:weight:) so font picker changes propagate
    /// to every Text/Label without re-touching every callsite.
    @MainActor
    static func app(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> Font {
        guard let store = FontStore.shared,
              let postScript = store.resolvedPostScript(),
              let ui = UIFont(name: postScript, size: size)
        else {
            return .system(size: size, weight: weight, design: design)
        }
        _ = store.generation
        // Build Font from the already-resolved UIFont — SwiftUI's
        // Font.custom caches name lookups and doesn't refresh after
        // late registration. Font(UIFont) bypasses the cache.
        // Weight + design parameters are intentionally dropped here:
        // synthesizing weight via UIFontDescriptor traits silently
        // falls back to a different family when our single-ttf doesn't
        // have a bold variant (which is why titles + monospaced labels
        // were rendering in two different fonts). Apply bold via
        // .bold() / .fontWeight() at the callsite if needed.
        return Font(ui)
    }
}

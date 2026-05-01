import UIKit

actor ThumbnailCache {
    static let shared = ThumbnailCache()

    private let memory = NSCache<NSString, UIImage>()
    private let session: URLSession
    private var inFlight: [String: Task<UIImage?, Never>] = [:]
    private let diskDir: URL

    init() {
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .returnCacheDataElseLoad
        config.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
        session = URLSession(configuration: config)
        memory.countLimit = 200
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        diskDir = caches.appendingPathComponent("thumbnails")
        try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
    }

    func image(id: String, url: String?) async -> UIImage? {
        if let cached = memory.object(forKey: id as NSString) { return cached }
        if let task = inFlight[id] { return await task.value }
        let task = Task<UIImage?, Never> { await fetch(id: id, url: url) }
        inFlight[id] = task
        let result = await task.value
        inFlight[id] = nil
        return result
    }

    func prefetch(id: String, url: String?) {
        guard memory.object(forKey: id as NSString) == nil, inFlight[id] == nil else { return }
        let task = Task<UIImage?, Never> { await fetch(id: id, url: url) }
        inFlight[id] = task
    }

    private func fetch(id: String, url: String?) async -> UIImage? {
        let onDisk = diskDir.appendingPathComponent(id + ".jpg")
        if let data = try? Data(contentsOf: onDisk), let img = UIImage(data: data) {
            memory.setObject(img, forKey: id as NSString)
            return img
        }
        guard let urlStr = url, let u = URL(string: urlStr) else { return nil }
        do {
            let (data, _) = try await session.data(from: u)
            try? data.write(to: onDisk)
            if let img = UIImage(data: data) {
                memory.setObject(img, forKey: id as NSString)
                return img
            }
        } catch {
            // Fallback to hqdefault path
            if !urlStr.contains("hqdefault.jpg"), let v = u.path.split(separator: "/").dropLast().last {
                let fallback = "https://i.ytimg.com/vi/\(v)/hqdefault.jpg"
                if let fallbackURL = URL(string: fallback), let (data, _) = try? await session.data(from: fallbackURL), let img = UIImage(data: data) {
                    try? data.write(to: onDisk)
                    memory.setObject(img, forKey: id as NSString)
                    return img
                }
            }
        }
        return nil
    }
}

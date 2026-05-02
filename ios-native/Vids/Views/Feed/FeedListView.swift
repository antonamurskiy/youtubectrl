import SwiftUI
import UIKit

/// UICollectionView-backed feed list. SwiftUI List + LazyVStack are not
/// fast enough for 200+ thumbnail cells with hover preview at 120Hz on
/// ProMotion. Wrap UICollectionView via UIViewRepresentable, build cells
/// with UIHostingConfiguration so cell content is still declarative.
struct FeedListView: UIViewRepresentable {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services
    let onSwipe: (Int) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(feed: feed, services: services, onSwipe: onSwipe)
    }

    func makeUIView(context: Context) -> UICollectionView {
        let layout = UICollectionViewCompositionalLayout { sectionIndex, env in
            let isShorts = sectionIndex == 1
            if isShorts {
                let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .absolute(140), heightDimension: .absolute(220)))
                let group = NSCollectionLayoutGroup.horizontal(layoutSize: NSCollectionLayoutSize(widthDimension: .absolute(140), heightDimension: .absolute(220)), subitems: [item])
                let section = NSCollectionLayoutSection(group: group)
                section.orthogonalScrollingBehavior = .continuousGroupLeadingBoundary
                section.interGroupSpacing = 8
                // Header pill + small gap; safe area is handled by
                // the SwiftUI parent (we don't .ignoresSafeArea(.top)
                // anymore — it caused recursive cell layout on iOS 26).
                section.contentInsets = .init(top: 50, leading: 12, bottom: 8, trailing: 12)
                return section
            }
            let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(280)))
            let group = NSCollectionLayoutGroup.vertical(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(280)), subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = 12
            section.contentInsets = .init(top: 50, leading: 0, bottom: 280, trailing: 0)
            return section
        }
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.alwaysBounceVertical = true
        cv.delegate = context.coordinator
        cv.prefetchDataSource = context.coordinator
        // Don't auto-inset for safe area / NP bar; we manage bottom
        // padding via the section's contentInsets so scroll extends
        // visually past the bar, and the last row can be scrolled
        // above it.
        cv.contentInsetAdjustmentBehavior = .never
        let rc = UIRefreshControl()
        rc.tintColor = UIColor(red: 0xeb/255, green: 0xdb/255, blue: 0xb2/255, alpha: 1)
        rc.addTarget(context.coordinator, action: #selector(Coordinator.onRefresh(_:)), for: .valueChanged)
        cv.refreshControl = rc
        // Horizontal swipe to cycle tabs — UIKit recognizer with
        // shouldRecognizeSimultaneouslyWith so it coexists with the
        // collection view's vertical pan, and direction-lock so
        // vertical scrolls don't trigger a tab change.
        let swipe = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onTabSwipe(_:)))
        swipe.delegate = context.coordinator
        swipe.cancelsTouchesInView = false
        cv.addGestureRecognizer(swipe)
        context.coordinator.bind(to: cv)
        return cv
    }

    func updateUIView(_ uiView: UICollectionView, context: Context) {
        let videos = feed.currentVideos
        let shorts = feed.currentShorts
        let tick = feed.refreshTick
        context.coordinator.refresh(uiView, videos: videos, shorts: shorts)
        // Scroll to top whenever the refresh FAB has bumped the tick.
        if tick != context.coordinator.lastRefreshTick {
            context.coordinator.lastRefreshTick = tick
            if videos.count > 0 || shorts.count > 0 {
                uiView.setContentOffset(.zero, animated: true)
            }
        }
    }

    final class Coordinator: NSObject, UICollectionViewDelegate, UICollectionViewDataSourcePrefetching, UIGestureRecognizerDelegate {
        private let feed: FeedStore
        private let services: ServiceContainer
        private let onSwipe: (Int) -> Void
        private var dataSource: UICollectionViewDiffableDataSource<Section, Item>!
        private var swipeStart: CGPoint?
        var lastRefreshTick: Int = 0
        /// True while a horizontal swipe is in progress / just ended.
        /// Cell taps fire didSelectItemAt; we ignore them when this
        /// is true so swipes don't trigger accidental video plays.
        private var swipeActive: Bool = false

        enum Section: Hashable { case videos, shorts }
        enum Item: Hashable {
            case video(Video)
            case short(Short)
        }

        init(feed: FeedStore, services: ServiceContainer, onSwipe: @escaping (Int) -> Void) {
            self.feed = feed
            self.services = services
            self.onSwipe = onSwipe
        }

        // MARK: gesture coexistence

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard let pan = g as? UIPanGestureRecognizer, let v = pan.view else { return true }
            let vel = pan.velocity(in: v)
            // Only fire on horizontal-dominant motion. Vertical pans
            // go to the collection view's scroll.
            return abs(vel.x) > abs(vel.y)
        }

        @objc func onTabSwipe(_ g: UIPanGestureRecognizer) {
            guard let v = g.view else { return }
            switch g.state {
            case .began:
                swipeStart = g.location(in: v)
                swipeActive = true
            case .changed:
                // Once translation exceeds 12pt horizontally, cancel any
                // pending touch on a cell so didSelectItemAt doesn't
                // fire when the swipe lifts.
                let t = g.translation(in: v)
                if abs(t.x) > 12, let cv = v as? UICollectionView {
                    for visible in cv.visibleCells where visible.isHighlighted {
                        visible.isHighlighted = false
                    }
                }
            case .ended:
                guard let start = swipeStart else {
                    swipeActive = false
                    return
                }
                let end = g.location(in: v)
                let dx = end.x - start.x, dy = end.y - start.y
                swipeStart = nil
                // Delay clearing swipeActive a beat so a trailing tap
                // selection (some iOS systems fire it after the pan)
                // still gets ignored.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
                    self?.swipeActive = false
                }
                guard abs(dx) > 60, abs(dx) > abs(dy) * 1.5 else { return }
                onSwipe(dx > 0 ? -1 : 1)
            case .cancelled, .failed:
                swipeStart = nil
                swipeActive = false
            default: break
            }
        }

        func bind(to cv: UICollectionView) {
            // UIHostingConfiguration creates a fresh SwiftUI root so the
            // outer @Environment(FontStore) etc. don't propagate into
            // cells. Inject explicitly so cells re-render when the
            // chosen font changes.
            let svcs = self.services
            let videoReg = UICollectionView.CellRegistration<UICollectionViewCell, Video> { cell, _, video in
                cell.contentConfiguration = UIHostingConfiguration {
                    VideoCellView(video: video)
                        .environment(svcs)
                        .environment(svcs.fonts)
                        .environment(svcs.ui)
                        .environment(svcs.playback)
                        .font(Font.app(svcs.fonts.size))
                }
                .margins(.all, 0)
                cell.backgroundConfiguration = .clear()
            }
            let shortReg = UICollectionView.CellRegistration<UICollectionViewCell, Short> { cell, _, short in
                cell.contentConfiguration = UIHostingConfiguration {
                    ShortCellView(short: short)
                        .environment(svcs)
                        .environment(svcs.fonts)
                        .font(Font.app(svcs.fonts.size))
                }
                .margins(.all, 0)
                cell.backgroundConfiguration = .clear()
            }
            dataSource = UICollectionViewDiffableDataSource<Section, Item>(collectionView: cv) { cv, indexPath, item in
                switch item {
                case .video(let v): cv.dequeueConfiguredReusableCell(using: videoReg, for: indexPath, item: v)
                case .short(let s): cv.dequeueConfiguredReusableCell(using: shortReg, for: indexPath, item: s)
                }
            }
        }

        @MainActor
        func refresh(_ cv: UICollectionView, videos: [Video], shorts: [Short]) {
            var snap = NSDiffableDataSourceSnapshot<Section, Item>()
            if !videos.isEmpty {
                snap.appendSections([.videos])
                snap.appendItems(videos.map { .video($0) }, toSection: .videos)
            }
            if !shorts.isEmpty {
                snap.appendSections([.shorts])
                snap.appendItems(shorts.map { .short($0) }, toSection: .shorts)
            }
            dataSource.apply(snap, animatingDifferences: false)
        }

        func collectionView(_ cv: UICollectionView, didSelectItemAt indexPath: IndexPath) {
            // Ignore taps that land while a horizontal swipe was in
            // progress / just ended.
            if swipeActive {
                cv.deselectItem(at: indexPath, animated: false)
                return
            }
            guard let item = dataSource.itemIdentifier(for: indexPath) else { return }
            switch item {
            case .video(let v):
                guard let url = v.url ?? v.videoId.flatMap({ "https://www.youtube.com/watch?v=\($0)" }) else { return }
                Task { @MainActor in
                    do { try await self.services.api.play(url: url, title: v.title, channel: v.channel, thumbnail: v.thumbnail, isLive: v.isLive ?? v.live, startPercent: v.startPercent) }
                    catch { self.services.ui.toast("Play failed") }
                }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case .short(let s):
                guard let id = s.videoId else { return }
                Task { @MainActor in
                    do { try await self.services.api.play(url: "https://www.youtube.com/watch?v=\(id)", title: s.title) }
                    catch { self.services.ui.toast("Play failed") }
                }
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }

        func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
            for ip in indexPaths {
                guard let item = dataSource.itemIdentifier(for: ip) else { continue }
                if case .video(let v) = item, let id = v.videoId {
                    Task { await ThumbnailCache.shared.prefetch(id: id, url: v.thumbnail) }
                }
            }
            // Infinite scroll: load next page when prefetch reaches the
            // last 5 cells in the videos section.
            if let last = indexPaths.map(\.item).max() {
                let videos = feed.currentVideos
                if last >= videos.count - 5 {
                    let tab = feed.activeTab
                    Task { @MainActor in await feed.load(tab: tab, api: services.api, append: true) }
                }
            }
        }

        @objc func onRefresh(_ control: UIRefreshControl) {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            let tab = feed.activeTab
            Task { @MainActor in
                await feed.load(tab: tab, api: services.api, append: false)
                control.endRefreshing()
            }
        }

        // Long-press context menu.
        func collectionView(_ collectionView: UICollectionView,
                            contextMenuConfigurationForItemsAt indexPaths: [IndexPath],
                            point: CGPoint) -> UIContextMenuConfiguration? {
            guard let ip = indexPaths.first,
                  let item = dataSource.itemIdentifier(for: ip),
                  case .video(let v) = item else { return nil }
            return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
                guard let self else { return UIMenu() }
                let actions: [UIAction] = [
                    UIAction(title: "More from \(v.channel ?? "channel")", image: UIImage(systemName: "person.crop.rectangle")) { [weak self] _ in
                        guard let self else { return }
                        Task { @MainActor in
                            await self.feed.loadChannel(id: v.channelId, name: v.channel, api: self.services.api)
                        }
                    },
                    UIAction(title: "Copy link", image: UIImage(systemName: "link")) { _ in
                        if let url = v.url ?? v.videoId.flatMap({ "https://www.youtube.com/watch?v=\($0)" }) {
                            UIPasteboard.general.string = url
                        }
                    },
                    UIAction(title: "Watch on phone", image: UIImage(systemName: "iphone")) { [weak self] _ in
                        guard let self,
                              let url = v.url ?? v.videoId.flatMap({ "https://www.youtube.com/watch?v=\($0)" })
                        else { return }
                        Task { @MainActor in
                            await self.services.phoneMode.startPhoneOnly(url: url, services: self.services)
                        }
                    },
                    UIAction(title: "Not interested", image: UIImage(systemName: "hand.thumbsdown"), attributes: .destructive) { [weak self] _ in
                        guard let self, let token = v.notInterestedToken else { return }
                        Task { try? await self.services.api.notInterested(token: token) }
                    },
                ]
                return UIMenu(title: "", children: actions)
            }
        }
    }
}

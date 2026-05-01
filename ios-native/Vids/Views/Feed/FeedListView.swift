import SwiftUI
import UIKit

/// UICollectionView-backed feed list. SwiftUI List + LazyVStack are not
/// fast enough for 200+ thumbnail cells with hover preview at 120Hz on
/// ProMotion. Wrap UICollectionView via UIViewRepresentable, build cells
/// with UIHostingConfiguration so cell content is still declarative.
struct FeedListView: UIViewRepresentable {
    @Environment(FeedStore.self) private var feed
    @Environment(ServiceContainer.self) private var services

    func makeCoordinator() -> Coordinator {
        Coordinator(feed: feed, services: services)
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
                section.contentInsets = .init(top: 8, leading: 12, bottom: 8, trailing: 12)
                return section
            }
            let item = NSCollectionLayoutItem(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(280)))
            let group = NSCollectionLayoutGroup.vertical(layoutSize: NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(280)), subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = 12
            section.contentInsets = .init(top: 8, leading: 0, bottom: 280, trailing: 0)
            return section
        }
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.alwaysBounceVertical = true
        cv.delegate = context.coordinator
        cv.prefetchDataSource = context.coordinator
        // Pull-to-refresh.
        let rc = UIRefreshControl()
        rc.tintColor = .white
        rc.addTarget(context.coordinator, action: #selector(Coordinator.onRefresh(_:)), for: .valueChanged)
        cv.refreshControl = rc
        context.coordinator.bind(to: cv)
        return cv
    }

    func updateUIView(_ uiView: UICollectionView, context: Context) {
        // Read videos/shorts here so SwiftUI tracks them as deps of this view.
        let videos = feed.currentVideos
        let shorts = feed.currentShorts
        context.coordinator.refresh(uiView, videos: videos, shorts: shorts)
    }

    final class Coordinator: NSObject, UICollectionViewDelegate, UICollectionViewDataSourcePrefetching {
        private let feed: FeedStore
        private let services: ServiceContainer
        private var dataSource: UICollectionViewDiffableDataSource<Section, Item>!

        enum Section: Hashable { case videos, shorts }
        enum Item: Hashable {
            case video(Video)
            case short(Short)
        }

        init(feed: FeedStore, services: ServiceContainer) {
            self.feed = feed
            self.services = services
        }

        func bind(to cv: UICollectionView) {
            let videoReg = UICollectionView.CellRegistration<UICollectionViewCell, Video> { cell, _, video in
                cell.contentConfiguration = UIHostingConfiguration {
                    VideoCellView(video: video)
                }
                .margins(.all, 0)
                cell.backgroundConfiguration = .clear()
            }
            let shortReg = UICollectionView.CellRegistration<UICollectionViewCell, Short> { cell, _, short in
                cell.contentConfiguration = UIHostingConfiguration {
                    ShortCellView(short: short)
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

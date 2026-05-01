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
        context.coordinator.bind(to: cv)
        return cv
    }

    func updateUIView(_ uiView: UICollectionView, context: Context) {
        context.coordinator.refresh(uiView)
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
        func refresh(_ cv: UICollectionView) {
            var snap = NSDiffableDataSourceSnapshot<Section, Item>()
            let videos = feed.currentVideos
            let shorts = feed.currentShorts
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
                Task { try? await services.api.play(url: url, title: v.title, channel: v.channel, thumbnail: v.thumbnail, isLive: v.isLive ?? v.live, startPercent: v.startPercent) }
            case .short(let s):
                guard let id = s.videoId else { return }
                Task { try? await services.api.play(url: "https://www.youtube.com/watch?v=\(id)", title: s.title) }
            }
        }

        func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
            for ip in indexPaths {
                guard let item = dataSource.itemIdentifier(for: ip) else { continue }
                if case .video(let v) = item, let id = v.videoId {
                    ThumbnailCache.shared.prefetch(id: id, url: v.thumbnail)
                }
            }
        }
    }
}

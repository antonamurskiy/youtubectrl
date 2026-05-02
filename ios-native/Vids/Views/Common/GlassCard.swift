import SwiftUI

/// Shared Liquid Glass sheet card chrome used by SecretMenu and
/// AudioOutputSheet (and any future iOS 26 sheet view). One source of
/// truth so the two never drift visually.

extension View {
    /// Wraps content in a glass card matching iOS 26 Settings-style
    /// rounded surfaces.
    func glassCard() -> some View {
        self
            .padding(.horizontal, 18)
            .padding(.top, 18)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .glassEffect(.regular.tint(.black.opacity(0.10)),
                         in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.4), radius: 18, y: 8)
    }
}

/// Section with optional uppercase-cap header and rows separated by
/// flat hairlines. Place inside a `.glassCard()`.
struct CardSection<Content: View>: View {
    let header: String?
    @ViewBuilder var content: () -> Content

    init(_ header: String? = nil,
         @ViewBuilder _ content: @escaping () -> Content) {
        self.header = header
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                Text(header)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 12)
            }
            _VariadicView.Tree(CardSeparatedRows()) {
                content()
            }
        }
    }
}

/// Variadic tree that interleaves a flat 0.5pt hairline between every
/// child of a CardSection's content closure.
struct CardSeparatedRows: _VariadicView_MultiViewRoot {
    @ViewBuilder
    func body(children: _VariadicView.Children) -> some View {
        let last = children.last?.id
        ForEach(children) { child in
            child.padding(.vertical, 12)
            if child.id != last {
                Rectangle()
                    .fill(Color.white.opacity(0.10))
                    .frame(height: 0.5)
            }
        }
    }
}

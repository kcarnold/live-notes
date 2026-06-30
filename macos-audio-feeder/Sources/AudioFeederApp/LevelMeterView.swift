import SwiftUI

/// Horizontal level meter, mirroring the browser broadcast page's mic meter
/// (green fill, smooth animation). `level` is 0...1.
struct LevelMeterView: View {
    var level: Float
    var active: Bool

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color.gray.opacity(0.25))
                RoundedRectangle(cornerRadius: 3)
                    .fill(active ? Color.green : Color.gray)
                    .frame(width: max(0, min(1, CGFloat(level))) * geo.size.width)
                    .animation(.easeOut(duration: 0.075), value: level)
            }
        }
        .frame(height: 8)
    }
}

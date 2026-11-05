import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// One finger on the elevation profile: moved sideways it points along the route; held still for a moment first, it
/// marks a stretch. Moved up or down it gives way at once, so the panel scrolls and moves as everywhere else.
final class ProfileTouchRecognizer: UIGestureRecognizer {
    enum Mode { case point, select }

    private(set) var mode = Mode.point
    private var start = CGPoint.zero
    private static let hold: TimeInterval = 0.35
    /// What a finger moves before it means a direction.
    private static let slop: CGFloat = 8

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard event.allTouches?.count == 1, let touch = touches.first, state == .possible else {
            state = state == .possible ? .failed : .cancelled
            return
        }
        start = touch.location(in: view)
        perform(#selector(held), with: nil, afterDelay: Self.hold)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard state == .possible else { return state = .changed }
        guard let location = touches.first?.location(in: view) else { return }
        let (sideways, upright) = (abs(location.x - start.x), abs(location.y - start.y))
        if upright > Self.slop && upright > sideways {
            state = .failed
        } else if sideways > Self.slop {
            state = .began
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        state = state == .possible ? .failed : .ended
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = state == .possible ? .failed : .cancelled
    }

    override func reset() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(held), object: nil)
        mode = .point
    }

    @objc private func held() {
        guard state == .possible else { return }
        mode = .select
        state = .began
    }

    /// The panel's scrolling and the sheet's own drag wait until the finger has shown it does not mean the profile.
    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        guard other is UIPanGestureRecognizer, let view, let owner = other.view, owner !== view else { return false }
        return view.isDescendant(of: owner)
    }
}

/// The recognizer for SwiftUI: what the finger does and where it is across the view.
struct ProfileTouch: UIGestureRecognizerRepresentable {
    let action: (_ state: UIGestureRecognizer.State, _ mode: ProfileTouchRecognizer.Mode, _ x: CGFloat) -> Void

    func makeUIGestureRecognizer(context: Context) -> ProfileTouchRecognizer { ProfileTouchRecognizer() }

    func handleUIGestureRecognizerAction(_ recognizer: ProfileTouchRecognizer, context: Context) {
        action(recognizer.state, recognizer.mode, context.converter.localLocation.x)
    }
}

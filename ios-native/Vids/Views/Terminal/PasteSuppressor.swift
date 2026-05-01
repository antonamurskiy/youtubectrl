import UIKit
import ObjectiveC.runtime
import SwiftTerm

/// Method-swizzles SwiftTerm.TerminalView.canPerformAction so paste
/// actions are rejected. Subclassing is blocked (TerminalView's
/// methods are public-not-open), pasteConfiguration alone isn't enough
/// (SwiftTerm's UITextInput conformance still routes "paste:" through
/// the responder chain when iOS Universal Clipboard suggests pasting).
enum PasteSuppressor {
    private static var installed = false
    private static var originalCanPerform: IMP?

    static func install() {
        guard !installed else { return }
        installed = true
        let cls: AnyClass = SwiftTerm.TerminalView.self

        // 1) Reject any "paste*" selector at the responder chain.
        let canPerformSel = #selector(UIResponder.canPerformAction(_:withSender:))
        if let m = class_getInstanceMethod(cls, canPerformSel) {
            let block: @convention(block) (Any, Selector, Any?) -> Bool = { (this, action, sender) in
                let s = NSStringFromSelector(action)
                if s.range(of: "aste") != nil { return false }
                typealias OrigFn = @convention(c) (Any, Selector, Selector, Any?) -> Bool
                let orig = unsafeBitCast(originalCanPerform, to: OrigFn.self)
                return orig(this, canPerformSel, action, sender)
            }
            originalCanPerform = method_setImplementation(m, imp_implementationWithBlock(block as Any))
        }

        // 2) Replace paste: itself with a no-op so iOS can't sneak in
        // an auto-paste from Universal Clipboard.
        replacePasteSelector("paste:", on: cls)
        replacePasteSelector("pasteAndMatchStyle:", on: cls)
        replacePasteSelector("_pasteAsQuotation:", on: cls)

        // 3) Class extension also adds paste:, in case the original
        // class doesn't implement it (so the responder-chain walks up
        // to a parent UITextInput conformer).
        let block: @convention(block) (Any, Any?) -> Void = { _, _ in }
        let imp = imp_implementationWithBlock(block as Any)
        let types = "v@:@"  // void, self, _cmd, sender
        class_addMethod(cls, NSSelectorFromString("paste:"), imp, types)
        class_addMethod(cls, NSSelectorFromString("pasteAndMatchStyle:"), imp, types)
    }

    private static func replacePasteSelector(_ name: String, on cls: AnyClass) {
        let sel = NSSelectorFromString(name)
        guard let m = class_getInstanceMethod(cls, sel) else { return }
        let block: @convention(block) (Any, Any?) -> Void = { _, _ in
            // swallow paste — terminal explicit paste should use
            // a different mechanism if we ever want it.
        }
        method_setImplementation(m, imp_implementationWithBlock(block as Any))
    }
}

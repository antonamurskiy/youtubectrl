// Mute (or unmute) a specific audio output device by name substring,
// without changing the system's active output. macOS's
// `osascript -e 'set volume output muted true'` only touches the
// currently-selected output; this hits CoreAudio's per-device
// kAudioDevicePropertyMute directly so each non-headphone output
// stays silent regardless of where audio gets routed.
//
// usage:
//   audio-mute <name-substring> <true|false>
import CoreAudio
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: audio-mute <name-substring> <true|false>\n".data(using: .utf8)!)
    exit(1)
}
let target = args[1].lowercased()
let muteState: UInt32 = (args[2].lowercased() == "true" || args[2] == "1") ? 1 : 0

func getDeviceIds() -> [AudioObjectID] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids
}

func deviceName(_ id: AudioObjectID) -> String {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var sz = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let r = AudioObjectGetPropertyData(id, &addr, 0, nil, &sz, &name)
    if r != 0 { return "" }
    return (name?.takeRetainedValue() as String?) ?? ""
}

func hasOutputStream(_ id: AudioObjectID) -> Bool {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size)
    if size == 0 { return false }
    let buf = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { buf.deallocate() }
    let r = AudioObjectGetPropertyData(id, &addr, 0, nil, &size, buf)
    if r != 0 { return false }
    let abl = UnsafeMutableAudioBufferListPointer(buf.assumingMemoryBound(to: AudioBufferList.self))
    var channels: UInt32 = 0
    for b in abl { channels += b.mNumberChannels }
    return channels > 0
}

var matched = 0
for id in getDeviceIds() {
    guard hasOutputStream(id) else { continue }
    let name = deviceName(id)
    if !name.lowercased().contains(target) { continue }
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyMute,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var v = muteState
    let r = AudioObjectSetPropertyData(id, &addr, 0, nil, UInt32(MemoryLayout<UInt32>.size), &v)
    print("\(name)\t\(muteState)\t\(r)")
    if r == 0 { matched += 1 }
}
if matched == 0 { exit(2) }

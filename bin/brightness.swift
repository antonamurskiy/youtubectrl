import CoreGraphics
import Foundation

let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW)
guard handle != nil else { print("{}"); exit(1) }

typealias SetFn = @convention(c) (CGDirectDisplayID, Float) -> Int32
typealias GetFn = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32

guard let setSym = dlsym(handle, "DisplayServicesSetBrightness"),
      let getSym = dlsym(handle, "DisplayServicesGetBrightness") else { print("{}"); exit(1) }
let setBright = unsafeBitCast(setSym, to: SetFn.self)
let getBright = unsafeBitCast(getSym, to: GetFn.self)

var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &ids, &count)

func resolve(_ target: String) -> CGDirectDisplayID? {
  let t = target.lowercased()
  for id in ids {
    let isBuiltin = CGDisplayIsBuiltin(id) != 0
    if (t == "laptop" || t == "builtin") && isBuiltin { return id }
    if (t == "lg" || t == "main" || t == "external") && !isBuiltin { return id }
  }
  return nil
}

let args = CommandLine.arguments
if args.count >= 2 {
  let cmd = args[1]
  if cmd == "list" {
    var entries: [[String: Any]] = []
    for id in ids {
      var v: Float = 0
      _ = getBright(id, &v)
      entries.append([
        "id": Int(id),
        "builtin": CGDisplayIsBuiltin(id) != 0,
        "main": CGMainDisplayID() == id,
        "brightness": v,
      ])
    }
    let data = try! JSONSerialization.data(withJSONObject: entries, options: [])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
  }
  if args.count >= 3 && cmd == "get" {
    guard let id = resolve(args[2]) else { print("{}"); exit(1) }
    var v: Float = 0
    let r = getBright(id, &v)
    if r != 0 { print("{}"); exit(1) }
    print("{\"brightness\":\(v)}")
    exit(0)
  }
  if args.count >= 4 && cmd == "set" {
    guard let id = resolve(args[2]), let val = Float(args[3]) else { print("{}"); exit(1) }
    let clamped = max(0, min(1, val))
    let r = setBright(id, clamped)
    print("{\"ok\":\(r == 0),\"brightness\":\(clamped)}")
    exit(0)
  }
}

print("usage: brightness list | get <laptop|lg> | set <laptop|lg> <0..1>")
exit(2)

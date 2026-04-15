import Foundation
import IOBluetooth

let keys = [
    "batteryPercentSingle",
    "batteryPercentLeft",
    "batteryPercentRight",
    "batteryPercentCase",
    "batteryPercentCombined",
]

let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? []
var results: [[String: Any]] = []

for d in devices {
    let n = d as NSObject
    var entry: [String: Any] = [:]
    if let addr = d.addressString {
        entry["address"] = addr.replacingOccurrences(of: "-", with: ":").lowercased()
    }
    entry["name"] = d.name ?? ""
    entry["connected"] = d.isConnected()
    for k in keys {
        if let v = n.value(forKey: k) as? NSNumber, v.intValue > 0 {
            entry[k] = v.intValue
        }
    }
    results.append(entry)
}

if let data = try? JSONSerialization.data(withJSONObject: results, options: []),
   let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("[]")
}

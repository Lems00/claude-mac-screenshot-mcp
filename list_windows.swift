import CoreGraphics
import Foundation

struct WindowInfo: Codable {
    let windowNumber: Int
    let ownerName: String
    let name: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let layer: Int
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windowListInfo = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: AnyObject]] else {
    print("[]")
    exit(0)
}

var results: [WindowInfo] = []

for window in windowListInfo {
    guard let ownerName = window[kCGWindowOwnerName as String] as? String,
          let windowNumber = window[kCGWindowNumber as String] as? Int,
          let boundsDict = window[kCGWindowBounds as String] as? [String: Double],
          let layer = window[kCGWindowLayer as String] as? Int else {
        continue
    }
    let name = window[kCGWindowName as String] as? String ?? ""
    let x = boundsDict["X"] ?? 0
    let y = boundsDict["Y"] ?? 0
    let width = boundsDict["Width"] ?? 0
    let height = boundsDict["Height"] ?? 0

    results.append(
        WindowInfo(
            windowNumber: windowNumber,
            ownerName: ownerName,
            name: name,
            x: x,
            y: y,
            width: width,
            height: height,
            layer: layer
        )
    )
}

let encoder = JSONEncoder()
if let data = try? encoder.encode(results), let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("[]")
}

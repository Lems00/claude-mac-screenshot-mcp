import ScreenCaptureKit
import CoreGraphics
import CoreImage
import Foundation

final class Capturer: NSObject, SCStreamOutput, SCStreamDelegate {
    let outputPath: String
    let semaphore = DispatchSemaphore(value: 0)
    var done = false

    init(outputPath: String) {
        self.outputPath = outputPath
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !done, type == .screen, sampleBuffer.isValid else { return }
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: imageBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }

        let url = URL(fileURLWithPath: outputPath)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(dest, cgImage, nil)
        CGImageDestinationFinalize(dest)

        done = true
        semaphore.signal()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        if !done {
            done = true
            semaphore.signal()
        }
    }
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("Usage: capture_window <appNameSubstring> <outputPath>\n".data(using: .utf8)!)
    exit(1)
}
let needle = args[1].lowercased()
let outputPath = args[2]

let mainSemaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let matches = content.windows.filter { w in
            guard let app = w.owningApplication else { return false }
            return app.applicationName.lowercased().contains(needle) && w.frame.width > 50 && w.frame.height > 50
        }.sorted { $0.frame.width * $0.frame.height > $1.frame.width * $1.frame.height }

        guard let window = matches.first else {
            print("NO_WINDOW_FOUND")
            exitCode = 2
            mainSemaphore.signal()
            return
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = max(Int(window.frame.width), 2)
        config.height = max(Int(window.frame.height), 2)
        config.showsCursor = false

        let capturer = Capturer(outputPath: outputPath)
        let stream = SCStream(filter: filter, configuration: config, delegate: capturer)
        try stream.addStreamOutput(capturer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "capture.queue"))
        try await stream.startCapture()

        let waitResult = capturer.semaphore.wait(timeout: .now() + 10)
        try? await stream.stopCapture()

        if waitResult == .timedOut || !capturer.done {
            print("TIMEOUT_OR_FAILED")
            exitCode = 3
        } else {
            print("OK:\(window.owningApplication?.applicationName ?? "")|\(window.windowID)")
        }
    } catch {
        print("ERROR:\(error)")
        exitCode = 1
    }
    mainSemaphore.signal()
}

mainSemaphore.wait()
exit(exitCode)

// swift-tools-version:5.9
import PackageDescription

// A library, not an app target.
//
// The reason is verification: `swift build` and `swift test` run on a GitHub
// macOS runner with no simulator, no device, no provisioning profile and no
// Apple Developer account. That means the model and the relay client — where
// the real logic and the real bugs live — are genuinely testable here, instead
// of being code nobody has ever run.
//
// The SwiftUI layer is inside the library on purpose: the compiler typechecks
// it on every CI run, so a view cannot silently rot. What it cannot do is
// launch, and this package never claims that it does.
let package = Package(
    name: "CryptoricKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CryptoricKit", targets: ["CryptoricKit"])
    ],
    targets: [
        .target(name: "CryptoricKit"),
        .testTarget(name: "CryptoricKitTests", dependencies: ["CryptoricKit"])
    ]
)
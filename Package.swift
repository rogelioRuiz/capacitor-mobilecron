// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorMobilecron",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "CapacitorMobilecron",
            targets: ["MobileCronPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(path: "../capacitor-native-agent")
    ],
    targets: [
        .target(
            name: "MobileCronPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorNativeAgent", package: "capacitor-native-agent")
            ],
            path: "ios/Plugin",
            exclude: ["MobileCronPlugin.m"]
        )
    ]
)
